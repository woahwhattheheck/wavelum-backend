import axios, { AxiosInstance, AxiosResponse } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { diff } from 'deep-diff';

interface ContractDefinition {
  name: string;
  version: string;
  endpoints: EndpointContract[];
  metadata?: {
    description?: string;
    tags?: string[];
    owner?: string;
  };
}

interface EndpointContract {
  path: string;
  method: string;
  request: {
    headers?: Record<string, HeaderContract>;
    params?: Record<string, ParamContract>;
    query?: Record<string, ParamContract>;
    body?: BodyContract;
  };
  response: {
    [statusCode: number]: ResponseContract;
  };
  metadata?: {
    description?: string;
    deprecated?: boolean;
    tags?: string[];
  };
}

interface HeaderContract {
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  pattern?: string;
  enum?: string[];
  description?: string;
}

interface ParamContract {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  pattern?: string;
  enum?: any[];
  min?: number;
  max?: number;
  description?: string;
}

interface BodyContract {
  contentType: string;
  schema: SchemaContract;
  required?: boolean;
}

interface ResponseContract {
  contentType: string;
  schema: SchemaContract;
  headers?: Record<string, HeaderContract>;
}

interface SchemaContract {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  properties?: Record<string, SchemaContract>;
  items?: SchemaContract;
  required?: string[];
  enum?: any[];
  pattern?: string;
  min?: number;
  max?: number;
  description?: string;
}

interface ContractTestResult {
  contractName: string;
  endpoint: string;
  method: string;
  status: 'passed' | 'failed' | 'warning';
  violations: ContractViolation[];
  responseTime: number;
  actualResponse?: any;
  expectedResponse?: any;
}

interface ContractViolation {
  type: 'missing_field' | 'extra_field' | 'type_mismatch' | 'value_constraint' | 'header_missing' | 'content_type_mismatch';
  field?: string;
  expected: any;
  actual: any;
  message: string;
  severity: 'error' | 'warning';
}

interface ContractTestReport {
  timestamp: string;
  environment: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    passRate: number;
  };
  results: ContractTestResult[];
}

export class ContractTester {
  private httpClient: AxiosInstance;
  private contracts: Map<string, ContractDefinition> = new Map();
  private testResults: ContractTestResult[] = [];

  constructor(baseURL: string, timeout: number = 30000) {
    this.httpClient = axios.create({
      baseURL,
      timeout,
      validateStatus: () => true, // Don't throw on HTTP errors
    });
  }

  async loadContractFromFile(filePath: string): Promise<void> {
    try {
      const contractData = await fs.readFile(filePath, 'utf-8');
      const contract: ContractDefinition = JSON.parse(contractData);
      this.contracts.set(contract.name, contract);
    } catch (error) {
      throw new Error(`Failed to load contract from ${filePath}: ${error}`);
    }
  }

  async loadContractsFromDirectory(directoryPath: string): Promise<void> {
    try {
      const files = await fs.readdir(directoryPath);
      const contractFiles = files.filter(file => file.endsWith('.json') || file.endsWith('.contract'));

      for (const file of contractFiles) {
        const filePath = path.join(directoryPath, file);
        await this.loadContractFromFile(filePath);
      }
    } catch (error) {
      throw new Error(`Failed to load contracts from directory ${directoryPath}: ${error}`);
    }
  }

  addContract(contract: ContractDefinition): void {
    this.contracts.set(contract.name, contract);
  }

  async testContract(contractName: string, testOptions?: {
    environment?: string;
    authHeaders?: Record<string, string>;
    sampleData?: Record<string, any>;
  }): Promise<ContractTestReport> {
    const contract = this.contracts.get(contractName);
    if (!contract) {
      throw new Error(`Contract not found: ${contractName}`);
    }

    this.testResults = [];
    const environment = testOptions?.environment || 'test';

    for (const endpoint of contract.endpoints) {
      const result = await this.testEndpoint(endpoint, testOptions);
      this.testResults.push(result);
    }

    return this.generateReport(contractName, environment);
  }

  async testAllContracts(testOptions?: {
    environment?: string;
    authHeaders?: Record<string, string>;
    sampleData?: Record<string, any>;
  }): Promise<ContractTestReport[]> {
    const reports: ContractTestReport[] = [];

    for (const [contractName] of this.contracts) {
      try {
        const report = await this.testContract(contractName, testOptions);
        reports.push(report);
      } catch (error) {
        console.error(`Failed to test contract ${contractName}:`, error);
      }
    }

    return reports;
  }

  private async testEndpoint(
    endpoint: EndpointContract,
    testOptions?: {
      authHeaders?: Record<string, string>;
      sampleData?: Record<string, any>;
    }
  ): Promise<ContractTestResult> {
    const startTime = Date.now();
    const violations: ContractViolation[] = [];

    try {
      // Build request
      const requestConfig = await this.buildRequestConfig(endpoint, testOptions);
      
      // Make the request
      const response = await this.httpClient.request({
        method: endpoint.method.toLowerCase(),
        url: this.resolvePath(endpoint.path, testOptions?.sampleData),
        ...requestConfig,
      });

      const responseTime = Date.now() - startTime;

      // Validate response
      const responseViolations = await this.validateResponse(endpoint, response);
      violations.push(...responseViolations);

      return {
        contractName: '', // Will be set by caller
        endpoint: endpoint.path,
        method: endpoint.method,
        status: violations.some(v => v.severity === 'error') ? 'failed' : 
                violations.some(v => v.severity === 'warning') ? 'warning' : 'passed',
        violations,
        responseTime,
        actualResponse: response.data,
      };

    } catch (error) {
      return {
        contractName: '', // Will be set by caller
        endpoint: endpoint.path,
        method: endpoint.method,
        status: 'failed',
        violations: [{
          type: 'missing_field',
          expected: 'Successful response',
          actual: error,
          message: `Request failed: ${error}`,
          severity: 'error',
        }],
        responseTime: Date.now() - startTime,
      };
    }
  }

  private async buildRequestConfig(
    endpoint: EndpointContract,
    testOptions?: {
      authHeaders?: Record<string, string>;
      sampleData?: Record<string, any>;
    }
  ): Promise<any> {
    const config: any = {
      headers: {},
    };

    // Add default headers
    if (endpoint.request.headers) {
      for (const [name, header] of Object.entries(endpoint.request.headers)) {
        if (header.required || testOptions?.sampleData?.[name]) {
          config.headers[name] = testOptions?.sampleData?.[name] || this.generateSampleValue(header);
        }
      }
    }

    // Add authentication headers
    if (testOptions?.authHeaders) {
      Object.assign(config.headers, testOptions.authHeaders);
    }

    // Add query parameters
    if (endpoint.request.query) {
      config.params = {};
      for (const [name, param] of Object.entries(endpoint.request.query)) {
        if (param.required || testOptions?.sampleData?.[name]) {
          config.params[name] = testOptions?.sampleData?.[name] || this.generateSampleValue(param);
        }
      }
    }

    // Add request body
    if (endpoint.request.body) {
      config.data = this.generateSampleData(endpoint.request.body.schema, testOptions?.sampleData);
      config.headers['Content-Type'] = endpoint.request.body.contentType;
    }

    return config;
  }

  private resolvePath(path: string, sampleData?: Record<string, any>): string {
    return path.replace(/{([^}]+)}/g, (match, paramName) => {
      return sampleData?.[paramName] || `sample-${paramName}`;
    });
  }

  private async validateResponse(
    endpoint: EndpointContract,
    response: AxiosResponse
  ): Promise<ContractViolation[]> {
    const violations: ContractViolation[] = [];

    // Check if we have a contract for this status code
    const responseContract = endpoint.response[response.status];
    if (!responseContract) {
      violations.push({
        type: 'missing_field',
        expected: Object.keys(endpoint.response),
        actual: response.status,
        message: `Unexpected status code: ${response.status}`,
        severity: 'error',
      });
      return violations;
    }

    // Validate content type
    if (responseContract.contentType) {
      const actualContentType = response.headers['content-type'];
      if (typeof actualContentType !== 'string' || !actualContentType.includes(responseContract.contentType)) {
        violations.push({
          type: 'content_type_mismatch',
          expected: responseContract.contentType,
          actual: actualContentType,
          message: `Content-Type mismatch. Expected: ${responseContract.contentType}, Got: ${actualContentType}`,
          severity: 'error',
        });
      }
    }

    // Validate response headers
    if (responseContract.headers) {
      for (const [name, header] of Object.entries(responseContract.headers)) {
        const actualValue = response.headers[name.toLowerCase()];
        
        if (header.required && !actualValue) {
          violations.push({
            type: 'header_missing',
            expected: name,
            actual: undefined,
            message: `Required header missing: ${name}`,
            severity: 'error',
          });
        } else if (actualValue && header.pattern && !new RegExp(header.pattern).test(actualValue)) {
          violations.push({
            type: 'value_constraint',
            expected: header.pattern,
            actual: actualValue,
            message: `Header ${name} does not match pattern: ${header.pattern}`,
            severity: 'error',
          });
        }
      }
    }

    // Validate response body
    if (responseContract.schema && response.data) {
      const bodyViolations = this.validateSchema(
        responseContract.schema,
        response.data,
        'response.body'
      );
      violations.push(...bodyViolations);
    }

    return violations;
  }

  private validateSchema(
    schema: SchemaContract,
    data: any,
    path: string = ''
  ): ContractViolation[] {
    const violations: ContractViolation[] = [];

    // Type validation
    if (schema.type === 'object') {
      if (!data || typeof data !== 'object') {
        violations.push({
          type: 'type_mismatch',
          expected: 'object',
          actual: typeof data,
          message: `${path} should be an object`,
          severity: 'error',
        });
        return violations;
      }

      // Check required properties
      if (schema.required) {
        for (const requiredProp of schema.required) {
          if (!(requiredProp in data)) {
            violations.push({
              type: 'missing_field',
              expected: requiredProp,
              actual: undefined,
              message: `Required field missing: ${path}.${requiredProp}`,
              severity: 'error',
            });
          }
        }
      }

      // Validate properties
      if (schema.properties) {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          if (propName in data) {
            const propViolations = this.validateSchema(
              propSchema,
              data[propName],
              `${path}.${propName}`
            );
            violations.push(...propViolations);
          }
        }
      }

      // Check for extra fields
      const knownFields = new Set(Object.keys(schema.properties || {}));
      const actualFields = new Set(Object.keys(data));
      const extraFields = [...actualFields].filter(field => !knownFields.has(field));
      
      if (extraFields.length > 0) {
        violations.push({
          type: 'extra_field',
          expected: Array.from(knownFields),
          actual: extraFields,
          message: `Unexpected fields in ${path}: ${extraFields.join(', ')}`,
          severity: 'warning',
        });
      }

    } else if (schema.type === 'array') {
      if (!Array.isArray(data)) {
        violations.push({
          type: 'type_mismatch',
          expected: 'array',
          actual: typeof data,
          message: `${path} should be an array`,
          severity: 'error',
        });
      } else if (schema.items) {
        data.forEach((item, index) => {
          const itemViolations = this.validateSchema(
            schema.items!,
            item,
            `${path}[${index}]`
          );
          violations.push(...itemViolations);
        });
      }

    } else {
      // Primitive type validation
      const expectedType = schema.type;
      const actualType = typeof data;
      
      if (actualType !== expectedType) {
        violations.push({
          type: 'type_mismatch',
          expected: expectedType,
          actual: actualType,
          message: `${path} should be ${expectedType}, got ${actualType}`,
          severity: 'error',
        });
      }

      // Enum validation
      if (schema.enum && !schema.enum.includes(data)) {
        violations.push({
          type: 'value_constraint',
          expected: schema.enum,
          actual: data,
          message: `${path} should be one of: ${schema.enum.join(', ')}`,
          severity: 'error',
        });
      }

      // Pattern validation
      if (schema.pattern && typeof data === 'string') {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(data)) {
          violations.push({
            type: 'value_constraint',
            expected: schema.pattern,
            actual: data,
            message: `${path} does not match pattern: ${schema.pattern}`,
            severity: 'error',
          });
        }
      }

      // Range validation
      if (typeof data === 'number') {
        if (schema.min !== undefined && data < schema.min) {
          violations.push({
            type: 'value_constraint',
            expected: `>= ${schema.min}`,
            actual: data,
            message: `${path} should be >= ${schema.min}`,
            severity: 'error',
          });
        }
        if (schema.max !== undefined && data > schema.max) {
          violations.push({
            type: 'value_constraint',
            expected: `<= ${schema.max}`,
            actual: data,
            message: `${path} should be <= ${schema.max}`,
            severity: 'error',
          });
        }
      }
    }

    return violations;
  }

  private generateSampleValue(contract: HeaderContract | ParamContract): any {
    switch (contract.type) {
      case 'string':
        if (contract.enum) return contract.enum[0];
        if (contract.pattern) {
          // Simple pattern matching for common cases
          if (contract.pattern.includes('email')) return 'test@example.com';
          if (contract.pattern.includes('uuid')) return '550e8400-e29b-41d4-a716-446655440000';
        }
        return 'sample-string';
      case 'number':
        return 'min' in contract && typeof contract.min === 'number' ? contract.min : 42;
      case 'boolean':
        return true;
      default:
        return null;
    }
  }

  private generateSampleData(schema: SchemaContract, sampleData?: Record<string, any>): any {
    if (sampleData && Object.keys(sampleData).length > 0) {
      return sampleData;
    }

    switch (schema.type) {
      case 'object':
        const obj: any = {};
        if (schema.properties) {
          for (const [key, prop] of Object.entries(schema.properties)) {
            obj[key] = this.generateSampleData(prop);
          }
        }
        return obj;
      case 'array':
        return schema.items ? [this.generateSampleData(schema.items)] : [];
      case 'string':
        return schema.enum ? schema.enum[0] : 'sample-string';
      case 'number':
        return schema.min !== undefined ? schema.min : 42;
      case 'boolean':
        return true;
      default:
        return null;
    }
  }

  private generateReport(contractName: string, environment: string): ContractTestReport {
    const total = this.testResults.length;
    const passed = this.testResults.filter(r => r.status === 'passed').length;
    const failed = this.testResults.filter(r => r.status === 'failed').length;
    const warnings = this.testResults.filter(r => r.status === 'warning').length;

    // Set contract name for all results
    this.testResults.forEach(result => {
      result.contractName = contractName;
    });

    return {
      timestamp: new Date().toISOString(),
      environment,
      summary: {
        total,
        passed,
        failed,
        warnings,
        passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
      },
      results: this.testResults,
    };
  }

  async saveReport(report: ContractTestReport, outputPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  }

  async generateContractFromAPI(baseURL: string, outputPath: string): Promise<ContractDefinition> {
    const contract: ContractDefinition = {
      name: `Generated Contract - ${new Date().toISOString().split('T')[0]}`,
      version: '1.0.0',
      endpoints: [],
      metadata: {
        description: `Auto-generated contract from API at ${baseURL}`,
        tags: ['auto-generated'],
      },
    };

    // Discover endpoints by trying common patterns
    const commonEndpoints = [
      { path: '/api/users', methods: ['GET', 'POST'] },
      { path: '/api/users/{id}', methods: ['GET', 'PUT', 'DELETE'] },
      { path: '/api/auth/login', methods: ['POST'] },
      { path: '/api/auth/register', methods: ['POST'] },
      { path: '/api/vaults', methods: ['GET', 'POST'] },
      { path: '/api/vaults/{id}', methods: ['GET', 'PUT', 'DELETE'] },
      { path: '/api/tokens', methods: ['GET'] },
      { path: '/api/organizations', methods: ['GET', 'POST'] },
    ];

    for (const endpoint of commonEndpoints) {
      for (const method of endpoint.methods) {
        try {
          const response = await this.httpClient.request({
            method: method.toLowerCase(),
            url: endpoint.path.replace('{id}', '1'),
          });

          const endpointContract: EndpointContract = {
            path: endpoint.path,
            method: method.toUpperCase(),
            request: {
              headers: {
                'Content-Type': {
                  type: 'string',
                  required: true,
                },
              },
            },
            response: {
              [response.status]: {
                contentType: 'application/json',
                schema: this.inferSchema(response.data),
              },
            },
          };

          contract.endpoints.push(endpointContract);
        } catch (error) {
          // Skip endpoints that don't exist or fail
        }
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(contract, null, 2), 'utf-8');

    return contract;
  }

  private inferSchema(data: any): SchemaContract {
    if (data === null || data === undefined) {
      return { type: 'object' };
    }

    if (Array.isArray(data)) {
      return {
        type: 'array',
        items: data.length > 0 ? this.inferSchema(data[0]) : { type: 'object' },
      };
    }

    if (typeof data === 'object') {
      const properties: Record<string, SchemaContract> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(data)) {
        properties[key] = this.inferSchema(value);
        required.push(key);
      }

      return {
        type: 'object',
        properties,
        required,
      };
    }

    return {
      type: typeof data as 'string' | 'number' | 'boolean',
    };
  }
}
