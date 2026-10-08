import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { performance } from 'perf_hooks';
import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';

interface BenchmarkConfig {
  baseURL: string;
  concurrency?: number;
  duration?: number; // in seconds
  rampUpTime?: number; // in seconds
  timeout?: number; // in milliseconds
  headers?: Record<string, string>;
  auth?: {
    type: 'bearer' | 'basic' | 'apikey';
    token?: string;
    username?: string;
    password?: string;
    apiKey?: string;
  };
}

interface LoadTestScenario {
  name: string;
  weight: number; // Percentage of total requests
  method: string;
  path: string;
  headers?: Record<string, string>;
  params?: Record<string, any>;
  body?: any;
  thinkTime?: number; // Time between requests in ms
  requestCount?: number; // Computed for distributed load scenarios
}

interface BenchmarkMetrics {
  scenario: string;
  method: string;
  path: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  requestsPerSecond: number;
  bytesTransferred: number;
  errors: ErrorSummary[];
}

interface ErrorSummary {
  type: string;
  message: string;
  count: number;
  percentage: number;
}

interface BenchmarkReport {
  timestamp: string;
  environment: string;
  config: BenchmarkConfig;
  scenarios: LoadTestScenario[];
  summary: {
    totalDuration: number;
    totalRequests: number;
    totalSuccessfulRequests: number;
    totalFailedRequests: number;
    overallRequestsPerSecond: number;
    averageResponseTime: number;
    passRate: number;
  };
  metrics: BenchmarkMetrics[];
  systemMetrics?: SystemMetrics;
}

interface SystemMetrics {
  cpu: {
    average: number;
    peak: number;
  };
  memory: {
    used: number;
    peak: number;
    total: number;
  };
  network: {
    bytesIn: number;
    bytesOut: number;
  };
}

interface RequestResult {
  scenario: string;
  method: string;
  path: string;
  statusCode: number;
  responseTime: number;
  timestamp: number;
  success: boolean;
  error?: string;
  bytesTransferred?: number;
}

export class PerformanceBenchmark extends EventEmitter {
  private httpClient: AxiosInstance;
  private config: BenchmarkConfig;
  private isRunning = false;
  private results: RequestResult[] = [];
  private startTime = 0;
  private endTime = 0;

  constructor(config: BenchmarkConfig) {
    super();
    this.config = {
      concurrency: 10,
      duration: 60,
      rampUpTime: 10,
      timeout: 30000,
      ...config,
    };

    this.httpClient = axios.create({
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      validateStatus: () => true, // Don't throw on HTTP errors
    });

    this.setupAuth();
  }

  private setupAuth(): void {
    if (!this.config.auth) return;

    switch (this.config.auth.type) {
      case 'bearer':
        this.httpClient.defaults.headers.common['Authorization'] = 
          `Bearer ${this.config.auth.token}`;
        break;
      case 'basic':
        if (this.config.auth.username && this.config.auth.password) {
          const credentials = Buffer.from(
            `${this.config.auth.username}:${this.config.auth.password}`
          ).toString('base64');
          this.httpClient.defaults.headers.common['Authorization'] = `Basic ${credentials}`;
        }
        break;
      case 'apikey':
        if (this.config.auth.apiKey) {
          this.httpClient.defaults.headers.common['X-API-Key'] = this.config.auth.apiKey;
        }
        break;
    }

    // Add custom headers
    if (this.config.headers) {
      Object.assign(this.httpClient.defaults.headers.common, this.config.headers);
    }
  }

  async runLoadTest(scenarios: LoadTestScenario[]): Promise<BenchmarkReport> {
    if (this.isRunning) {
      throw new Error('Benchmark is already running');
    }

    this.isRunning = true;
    this.results = [];
    this.startTime = performance.now();

    this.emit('benchmark:started', { scenarios, config: this.config });

    try {
      // Validate scenarios
      this.validateScenarios(scenarios);

      // Calculate total requests and distribution
      const totalRequests = this.calculateTotalRequests(scenarios);
      const weightedScenarios = this.distributeRequests(scenarios, totalRequests);

      // Start system metrics collection
      const systemMetricsCollector = this.startSystemMetricsCollection();

      // Execute load test
      await this.executeLoadTest(weightedScenarios);

      // Stop system metrics collection
      const systemMetrics = await systemMetricsCollector;

      this.endTime = performance.now();

      const report = this.generateReport(scenarios, systemMetrics);
      
      this.emit('benchmark:completed', report);
      return report;

    } catch (error) {
      this.emit('benchmark:error', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async runStressTest(
    scenarios: LoadTestScenario[],
    options: {
      maxConcurrency?: number;
      stepSize?: number;
      stepDuration?: number;
      maxDuration?: number;
    } = {}
  ): Promise<BenchmarkReport[]> {
    const reports: BenchmarkReport[] = [];
    const {
      maxConcurrency = 100,
      stepSize = 10,
      stepDuration = 60,
      maxDuration = 600,
    } = options;

    let currentConcurrency = stepSize;
    let totalDuration = 0;

    while (currentConcurrency <= maxConcurrency && totalDuration < maxDuration) {
      this.emit('stress:step', { concurrency: currentConcurrency, step: reports.length + 1 });

      const stepConfig = { ...this.config, concurrency: currentConcurrency };
      const benchmark = new PerformanceBenchmark(stepConfig);

      const report = await benchmark.runLoadTest(scenarios);
      reports.push(report);

      // Check if we should stop (high error rate or response time degradation)
      if (report.summary.passRate < 95 || report.summary.averageResponseTime > 5000) {
        this.emit('stress:threshold-reached', {
          concurrency: currentConcurrency,
          passRate: report.summary.passRate,
          avgResponseTime: report.summary.averageResponseTime,
        });
        break;
      }

      currentConcurrency += stepSize;
      totalDuration += stepDuration;

      // Brief pause between steps
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    return reports;
  }

  async runSpikeTest(
    scenarios: LoadTestScenario[],
    options: {
      normalConcurrency?: number;
      spikeConcurrency?: number;
      normalDuration?: number;
      spikeDuration?: number;
      cycles?: number;
    } = {}
  ): Promise<BenchmarkReport> {
    const {
      normalConcurrency = 10,
      spikeConcurrency = 100,
      normalDuration = 60,
      spikeDuration = 30,
      cycles = 3,
    } = options;

    const allResults: RequestResult[] = [];
    const allScenarios: LoadTestScenario[] = [];
    const systemMetrics: SystemMetrics[] = [];

    for (let cycle = 0; cycle < cycles; cycle++) {
      this.emit('spike:cycle', { cycle: cycle + 1, total: cycles });

      // Normal load phase
      const normalConfig = { ...this.config, concurrency: normalConcurrency };
      const normalBenchmark = new PerformanceBenchmark(normalConfig);
      
      const normalReport = await normalBenchmark.runLoadTest(scenarios);
      allResults.push(...normalBenchmark['results']);
      allScenarios.push(...scenarios);
      if (normalReport.systemMetrics) {
        systemMetrics.push(normalReport.systemMetrics);
      }

      // Spike phase
      const spikeConfig = { ...this.config, concurrency: spikeConcurrency };
      const spikeBenchmark = new PerformanceBenchmark(spikeConfig);
      
      const spikeReport = await spikeBenchmark.runLoadTest(scenarios);
      allResults.push(...spikeBenchmark['results']);
      allScenarios.push(...scenarios);
      if (spikeReport.systemMetrics) {
        systemMetrics.push(spikeReport.systemMetrics);
      }

      // Brief pause between cycles
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    // Generate combined report
    const combinedReport = this.generateCombinedReport(allScenarios, allResults, systemMetrics);
    this.emit('spike:completed', combinedReport);

    return combinedReport;
  }

  private validateScenarios(scenarios: LoadTestScenario[]): void {
    if (scenarios.length === 0) {
      throw new Error('At least one scenario must be provided');
    }

    const totalWeight = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
    if (Math.abs(totalWeight - 100) > 0.01) {
      throw new Error(`Scenario weights must sum to 100%, got ${totalWeight}%`);
    }

    for (const scenario of scenarios) {
      if (!scenario.name || !scenario.method || !scenario.path) {
        throw new Error('Each scenario must have name, method, and path');
      }

      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(scenario.method.toUpperCase())) {
        throw new Error(`Invalid HTTP method: ${scenario.method}`);
      }
    }
  }

  private calculateTotalRequests(scenarios: LoadTestScenario[]): number {
    const requestsPerSecond = this.config.concurrency || 10;
    const duration = this.config.duration || 60;
    return Math.floor(requestsPerSecond * duration);
  }

  private distributeRequests(scenarios: LoadTestScenario[], totalRequests: number): LoadTestScenario[] {
    const distributed: LoadTestScenario[] = [];

    for (const scenario of scenarios) {
      const requestCount = Math.floor((scenario.weight / 100) * totalRequests);
      distributed.push({
        ...scenario,
        requestCount,
      });
    }

    return distributed;
  }

  private async executeLoadTest(scenarios: LoadTestScenario[]): Promise<void> {
    const promises: Promise<void>[] = [];
    const concurrency = this.config.concurrency || 10;

    for (let i = 0; i < concurrency; i++) {
      promises.push(this.workerLoop(scenarios, i));
    }

    await Promise.all(promises);
  }

  private async workerLoop(scenarios: LoadTestScenario[], workerId: number): Promise<void> {
    const endTime = this.startTime + (this.config.duration! * 1000);
    const rampUpTime = this.config.rampUpTime! * 1000;
    const workerDelay = (rampUpTime / (this.config.concurrency || 1)) * workerId;

    // Wait for ramp-up delay
    if (workerDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, workerDelay));
    }

    while (performance.now() < endTime && this.isRunning) {
      // Select scenario based on weight
      const scenario = this.selectScenario(scenarios);
      
      // Execute request
      await this.executeRequest(scenario);

      // Apply think time
      if (scenario.thinkTime && scenario.thinkTime > 0) {
        await new Promise(resolve => setTimeout(resolve, scenario.thinkTime));
      }
    }
  }

  private selectScenario(scenarios: LoadTestScenario[]): LoadTestScenario {
    const random = Math.random() * 100;
    let cumulative = 0;

    for (const scenario of scenarios) {
      cumulative += scenario.weight;
      if (random <= cumulative) {
        return scenario;
      }
    }

    return scenarios[scenarios.length - 1];
  }

  private async executeRequest(scenario: LoadTestScenario): Promise<void> {
    const startTime = performance.now();

    try {
      const requestConfig: AxiosRequestConfig = {
        method: scenario.method.toLowerCase(),
        url: scenario.path,
        headers: scenario.headers,
        params: scenario.params,
      };

      if (scenario.body && ['POST', 'PUT', 'PATCH'].includes(scenario.method.toUpperCase())) {
        requestConfig.data = scenario.body;
      }

      const response = await this.httpClient.request(requestConfig);
      const endTime = performance.now();

      const result: RequestResult = {
        scenario: scenario.name,
        method: scenario.method,
        path: scenario.path,
        statusCode: response.status,
        responseTime: endTime - startTime,
        timestamp: Date.now(),
        success: response.status >= 200 && response.status < 400,
        bytesTransferred: JSON.stringify(response.data).length,
      };

      this.results.push(result);
      this.emit('request:completed', result);

    } catch (error: any) {
      const endTime = performance.now();

      const result: RequestResult = {
        scenario: scenario.name,
        method: scenario.method,
        path: scenario.path,
        statusCode: 0,
        responseTime: endTime - startTime,
        timestamp: Date.now(),
        success: false,
        error: error.message,
      };

      this.results.push(result);
      this.emit('request:failed', result);
    }
  }

  private startSystemMetricsCollection(): Promise<SystemMetrics> {
    return new Promise((resolve) => {
      const metrics: SystemMetrics = {
        cpu: { average: 0, peak: 0 },
        memory: { used: 0, peak: 0, total: 0 },
        network: { bytesIn: 0, bytesOut: 0 },
      };

      const interval = setInterval(() => {
        const memUsage = process.memoryUsage();
        
        metrics.memory.used = memUsage.heapUsed;
        metrics.memory.peak = Math.max(metrics.memory.peak, memUsage.heapUsed);
        metrics.memory.total = memUsage.heapTotal;

        // Simple CPU approximation (would need more sophisticated implementation in production)
        const cpuUsage = process.cpuUsage();
        metrics.cpu.average = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds
        metrics.cpu.peak = Math.max(metrics.cpu.peak, metrics.cpu.average);
      }, 1000);

      setTimeout(() => {
        clearInterval(interval);
        resolve(metrics);
      }, (this.config.duration || 60) * 1000);
    });
  }

  private generateReport(scenarios: LoadTestScenario[], systemMetrics?: SystemMetrics): BenchmarkReport {
    const duration = (this.endTime - this.startTime) / 1000;
    const scenarioMetrics = this.calculateScenarioMetrics(scenarios);
    const totalRequests = this.results.length;
    const successfulRequests = this.results.filter(r => r.success).length;
    const failedRequests = totalRequests - successfulRequests;

    return {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'test',
      config: this.config,
      scenarios,
      summary: {
        totalDuration: duration,
        totalRequests,
        totalSuccessfulRequests: successfulRequests,
        totalFailedRequests: failedRequests,
        overallRequestsPerSecond: totalRequests / duration,
        averageResponseTime: this.calculateAverageResponseTime(),
        passRate: (successfulRequests / totalRequests) * 100,
      },
      metrics: scenarioMetrics,
      systemMetrics,
    };
  }

  private generateCombinedReport(
    scenarios: LoadTestScenario[],
    results: RequestResult[],
    systemMetrics: SystemMetrics[]
  ): BenchmarkReport {
    this.results = results;
    const duration = (this.endTime - this.startTime) / 1000;
    const scenarioMetrics = this.calculateScenarioMetrics(scenarios);
    const totalRequests = results.length;
    const successfulRequests = results.filter(r => r.success).length;
    const failedRequests = totalRequests - successfulRequests;

    // Combine system metrics
    const combinedSystemMetrics: SystemMetrics = {
      cpu: {
        average: systemMetrics.reduce((sum, m) => sum + m.cpu.average, 0) / systemMetrics.length,
        peak: Math.max(...systemMetrics.map(m => m.cpu.peak)),
      },
      memory: {
        used: systemMetrics.reduce((sum, m) => sum + m.memory.used, 0) / systemMetrics.length,
        peak: Math.max(...systemMetrics.map(m => m.memory.peak)),
        total: Math.max(...systemMetrics.map(m => m.memory.total)),
      },
      network: {
        bytesIn: systemMetrics.reduce((sum, m) => sum + m.network.bytesIn, 0),
        bytesOut: systemMetrics.reduce((sum, m) => sum + m.network.bytesOut, 0),
      },
    };

    return {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'test',
      config: this.config,
      scenarios,
      summary: {
        totalDuration: duration,
        totalRequests,
        totalSuccessfulRequests: successfulRequests,
        totalFailedRequests: failedRequests,
        overallRequestsPerSecond: totalRequests / duration,
        averageResponseTime: this.calculateAverageResponseTime(),
        passRate: (successfulRequests / totalRequests) * 100,
      },
      metrics: scenarioMetrics,
      systemMetrics: combinedSystemMetrics,
    };
  }

  private calculateScenarioMetrics(scenarios: LoadTestScenario[]): BenchmarkMetrics[] {
    const metrics: BenchmarkMetrics[] = [];

    for (const scenario of scenarios) {
      const scenarioResults = this.results.filter(r => r.scenario === scenario.name);
      
      if (scenarioResults.length === 0) continue;

      const responseTimes = scenarioResults.map(r => r.responseTime).sort((a, b) => a - b);
      const successfulResults = scenarioResults.filter(r => r.success);
      const failedResults = scenarioResults.filter(r => !r.success);

      const errors = this.groupErrors(failedResults);

      metrics.push({
        scenario: scenario.name,
        method: scenario.method,
        path: scenario.path,
        totalRequests: scenarioResults.length,
        successfulRequests: successfulResults.length,
        failedRequests: failedResults.length,
        averageResponseTime: this.average(responseTimes),
        minResponseTime: Math.min(...responseTimes),
        maxResponseTime: Math.max(...responseTimes),
        p50: this.percentile(responseTimes, 50),
        p90: this.percentile(responseTimes, 90),
        p95: this.percentile(responseTimes, 95),
        p99: this.percentile(responseTimes, 99),
        requestsPerSecond: scenarioResults.length / ((this.endTime - this.startTime) / 1000),
        bytesTransferred: successfulResults.reduce((sum, r) => sum + (r.bytesTransferred || 0), 0),
        errors,
      });
    }

    return metrics;
  }

  private groupErrors(failedResults: RequestResult[]): ErrorSummary[] {
    const errorMap = new Map<string, { count: number; message: string }>();

    for (const result of failedResults) {
      const errorType = result.error || 'Unknown Error';
      const existing = errorMap.get(errorType);
      
      if (existing) {
        existing.count++;
      } else {
        errorMap.set(errorType, { count: 1, message: result.error || 'Unknown error occurred' });
      }
    }

    const totalErrors = failedResults.length;
    return Array.from(errorMap.entries()).map(([type, data]) => ({
      type,
      message: data.message,
      count: data.count,
      percentage: (data.count / totalErrors) * 100,
    }));
  }

  private calculateAverageResponseTime(): number {
    if (this.results.length === 0) return 0;
    return this.average(this.results.map(r => r.responseTime));
  }

  private average(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  }

  private percentile(sortedNumbers: number[], p: number): number {
    if (sortedNumbers.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedNumbers.length) - 1;
    return sortedNumbers[Math.max(0, index)];
  }

  async saveReport(report: BenchmarkReport, outputPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  }

  async generateHTMLReport(report: BenchmarkReport, outputPath: string): Promise<void> {
    const html = this.generateHTMLContent(report);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, 'utf-8');
  }

  private generateHTMLContent(report: BenchmarkReport): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Performance Benchmark Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 5px; }
        .summary { display: flex; gap: 20px; margin: 20px 0; }
        .metric { background: #e9ecef; padding: 15px; border-radius: 5px; text-align: center; }
        .metric h3 { margin: 0; color: #495057; }
        .metric .value { font-size: 24px; font-weight: bold; color: #007bff; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
        .pass { color: green; }
        .fail { color: red; }
        .warning { color: orange; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Performance Benchmark Report</h1>
        <p><strong>Generated:</strong> ${report.timestamp}</p>
        <p><strong>Environment:</strong> ${report.environment}</p>
        <p><strong>Duration:</strong> ${report.summary.totalDuration.toFixed(2)} seconds</p>
    </div>

    <div class="summary">
        <div class="metric">
            <h3>Total Requests</h3>
            <div class="value">${report.summary.totalRequests}</div>
        </div>
        <div class="metric">
            <h3>Pass Rate</h3>
            <div class="value ${report.summary.passRate >= 95 ? 'pass' : report.summary.passRate >= 90 ? 'warning' : 'fail'}">
                ${report.summary.passRate.toFixed(2)}%
            </div>
        </div>
        <div class="metric">
            <h3>Avg Response Time</h3>
            <div class="value">${report.summary.averageResponseTime.toFixed(2)}ms</div>
        </div>
        <div class="metric">
            <h3>Requests/sec</h3>
            <div class="value">${report.summary.overallRequestsPerSecond.toFixed(2)}</div>
        </div>
    </div>

    <h2>Scenario Metrics</h2>
    <table>
        <thead>
            <tr>
                <th>Scenario</th>
                <th>Method</th>
                <th>Path</th>
                <th>Requests</th>
                <th>Success Rate</th>
                <th>Avg Response Time</th>
                <th>P95 Response Time</th>
                <th>Requests/sec</th>
            </tr>
        </thead>
        <tbody>
            ${report.metrics.map(metric => `
                <tr>
                    <td>${metric.scenario}</td>
                    <td>${metric.method}</td>
                    <td>${metric.path}</td>
                    <td>${metric.totalRequests}</td>
                    <td class="${((metric.successfulRequests / metric.totalRequests) * 100) >= 95 ? 'pass' : 'fail'}">
                        ${((metric.successfulRequests / metric.totalRequests) * 100).toFixed(2)}%
                    </td>
                    <td>${metric.averageResponseTime.toFixed(2)}ms</td>
                    <td>${metric.p95.toFixed(2)}ms</td>
                    <td>${metric.requestsPerSecond.toFixed(2)}</td>
                </tr>
            `).join('')}
        </tbody>
    </table>

    ${report.systemMetrics ? `
    <h2>System Metrics</h2>
    <div class="summary">
        <div class="metric">
            <h3>CPU Peak</h3>
            <div class="value">${report.systemMetrics.cpu.peak.toFixed(2)}%</div>
        </div>
        <div class="metric">
            <h3>Memory Peak</h3>
            <div class="value">${(report.systemMetrics.memory.peak / 1024 / 1024).toFixed(2)}MB</div>
        </div>
        <div class="metric">
            <h3>Network Out</h3>
            <div class="value">${(report.systemMetrics.network.bytesOut / 1024 / 1024).toFixed(2)}MB</div>
        </div>
    </div>
    ` : ''}
</body>
</html>
    `;
  }
}
