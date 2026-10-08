import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { faker } from '@faker-js/faker';

interface EndpointSpec {
  method: string;
  path: string;
  parameters?: ParameterSpec[];
  requestBody?: RequestBodySpec;
  responses?: ResponseSpec[];
  authentication?: AuthenticationSpec;
}

interface ParameterSpec {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  type: string;
  example?: any;
}

interface RequestBodySpec {
  contentType: string;
  schema: any;
  example?: any;
}

interface ResponseSpec {
  statusCode: number;
  contentType: string;
  schema: any;
  example?: any;
}

interface AuthenticationSpec {
  type: 'bearer' | 'apikey' | 'basic';
  token?: string;
}

interface GeneratedTest {
  name: string;
  description: string;
  endpoint: string;
  method: string;
  testCases: TestCase[];
}

interface TestCase {
  name: string;
  description: string;
  request: {
    headers?: Record<string, string>;
    params?: Record<string, any>;
    query?: Record<string, any>;
    body?: any;
  };
  expectedResponse: {
    statusCode: number;
    headers?: Record<string, string>;
    body?: any;
  };
  setup?: string[];
  teardown?: string[];
}

export class TestGenerator {
  private httpClient: AxiosInstance;
  private outputDir: string;

  constructor(baseURL: string, outputDir: string = './generated-tests') {
    this.httpClient = axios.create({
      baseURL,
      timeout: 30000,
      validateStatus: () => true, // Don't throw on HTTP errors
    });

    this.outputDir = outputDir;
  }

  async generateTestsFromSwagger(swaggerSpec: any): Promise<GeneratedTest[]> {
    const tests: GeneratedTest[] = [];

    for (const [path, pathItem] of Object.entries(swaggerSpec.paths || {})) {
      for (const [method, operation] of Object.entries(pathItem as any)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
          const test = await this.generateTestForEndpoint(path, method, operation as any);
          tests.push(test);
        }
      }
    }

    return tests;
  }

  async generateTestForEndpoint(
    path: string,
    method: string,
    operation: any
  ): Promise<GeneratedTest> {
    const testCases: TestCase[] = [];

    // Generate happy path test case
    const happyPathCase = this.generateHappyPathTestCase(path, method, operation);
    testCases.push(happyPathCase);

    // Generate negative test cases
    const negativeCases = this.generateNegativeTestCases(path, method, operation);
    testCases.push(...negativeCases);

    // Generate edge cases
    const edgeCases = this.generateEdgeTestCases(path, method, operation);
    testCases.push(...edgeCases);

    return {
      name: `${method.toUpperCase()} ${path}`,
      description: operation.summary || `Tests for ${method.toUpperCase()} ${path}`,
      endpoint: path,
      method: method.toUpperCase(),
      testCases,
    };
  }

  private generateHappyPathTestCase(
    path: string,
    method: string,
    operation: any
  ): TestCase {
    const request: any = {
      headers: this.generateDefaultHeaders(operation),
    };

    // Generate path parameters
    const pathParams = this.extractPathParameters(path);
    if (pathParams.length > 0) {
      request.params = {};
      pathParams.forEach(param => {
        request.params[param] = this.generateMockValue(param, 'string');
      });
    }

    // Generate query parameters
    if (operation.parameters) {
      request.query = {};
      operation.parameters
        .filter((p: any) => p.in === 'query')
        .forEach((param: any) => {
          request.query[param.name] = this.generateMockValue(param.name, param.type);
        });
    }

    // Generate request body
    if (operation.requestBody) {
      request.body = this.generateMockRequestBody(operation.requestBody);
    }

    const successResponse = operation.responses?.['200'] || operation.responses?.['201'];

    return {
      name: 'Happy Path',
      description: 'Test with valid inputs and expected successful response',
      request,
      expectedResponse: {
        statusCode: parseInt(Object.keys(operation.responses || {})[0]) || 200,
        body: successResponse?.example || this.generateMockResponse(successResponse),
      },
    };
  }

  private generateNegativeTestCases(
    path: string,
    method: string,
    operation: any
  ): TestCase[] {
    const cases: TestCase[] = [];

    // Test missing required parameters
    if (operation.parameters) {
      const requiredParams = operation.parameters.filter((p: any) => p.required);
      requiredParams.forEach((param: any) => {
        const request: any = {
          headers: this.generateDefaultHeaders(operation),
        };

        if (param.in === 'path') {
          // Skip path parameter test as it would result in 404
          return;
        }

        if (param.in === 'query') {
          request.query = {};
          // Generate all other required params except this one
          operation.parameters
            .filter((p: any) => p.in === 'query' && p.required && p.name !== param.name)
            .forEach((p: any) => {
              request.query[p.name] = this.generateMockValue(p.name, p.type);
            });
        }

        cases.push({
          name: `Missing Required Parameter: ${param.name}`,
          description: `Test response when required parameter ${param.name} is missing`,
          request,
          expectedResponse: {
            statusCode: 400,
            body: { error: `Missing required parameter: ${param.name}` },
          },
        });
      });
    }

    // Test invalid authentication
    if (operation.security) {
      cases.push({
        name: 'Invalid Authentication',
        description: 'Test response with invalid or missing authentication',
        request: {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer invalid-token',
          },
        },
        expectedResponse: {
          statusCode: 401,
          body: { error: 'Unauthorized' },
        },
      });
    }

    // Test invalid request body
    if (operation.requestBody) {
      cases.push({
        name: 'Invalid Request Body',
        description: 'Test response with malformed request body',
        request: {
          headers: this.generateDefaultHeaders(operation),
          body: { invalid: 'data' },
        },
        expectedResponse: {
          statusCode: 400,
          body: { error: 'Invalid request body' },
        },
      });
    }

    return cases;
  }

  private generateEdgeTestCases(
    path: string,
    method: string,
    operation: any
  ): TestCase[] {
    const cases: TestCase[] = [];

    // Test with maximum values
    if (operation.parameters) {
      const numericParams = operation.parameters.filter((p: any) => 
        p.type === 'number' || p.type === 'integer'
      );
      
      numericParams.forEach((param: any) => {
        const request: any = {
          headers: this.generateDefaultHeaders(operation),
        };

        if (param.in === 'query') {
          request.query = {};
          request.query[param.name] = Number.MAX_SAFE_INTEGER;
        }

        cases.push({
          name: `Maximum Value: ${param.name}`,
          description: `Test with maximum safe integer value for ${param.name}`,
          request,
          expectedResponse: {
            statusCode: 200,
          },
        });
      });
    }

    // Test with empty arrays/objects
    if (operation.requestBody && operation.requestBody.content) {
      const request: any = {
        headers: this.generateDefaultHeaders(operation),
      };

      const contentType = Object.keys(operation.requestBody.content)[0];
      if (contentType.includes('json')) {
        request.body = {};
      }

      cases.push({
        name: 'Empty Request Body',
        description: 'Test with empty request body',
        request,
        expectedResponse: {
          statusCode: 400,
          body: { error: 'Request body cannot be empty' },
        },
      });
    }

    return cases;
  }

  private generateDefaultHeaders(operation: any): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication if required
    if (operation.security) {
      headers['Authorization'] = 'Bearer test-token';
    }

    return headers;
  }

  private extractPathParameters(path: string): string[] {
    const matches = path.match(/{([^}]+)}/g);
    return matches ? matches.map(match => match.slice(1, -1)) : [];
  }

  private generateMockValue(name: string, type: string): any {
    switch (type) {
      case 'string':
        if (name.toLowerCase().includes('email')) {
          return faker.internet.email();
        }
        if (name.toLowerCase().includes('name')) {
          return faker.person.fullName();
        }
        if (name.toLowerCase().includes('id')) {
          return faker.string.uuid();
        }
        return faker.lorem.words(3);
      case 'number':
      case 'integer':
        return faker.number.int({ min: 1, max: 1000 });
      case 'boolean':
        return faker.datatype.boolean();
      case 'array':
        return [this.generateMockValue('item', 'string')];
      case 'object':
        return { key: faker.lorem.word() };
      default:
        return faker.lorem.word();
    }
  }

  private generateMockRequestBody(requestBody: any): any {
    const contentType = Object.keys(requestBody.content || {})[0];
    if (!contentType) return {};

    const schema = requestBody.content[contentType]?.schema;
    if (!schema) return {};

    return this.generateMockData(schema);
  }

  private generateMockResponse(response: any): any {
    if (!response || !response.content) return {};

    const contentType = Object.keys(response.content)[0];
    const schema = response.content[contentType]?.schema;

    return schema ? this.generateMockData(schema) : {};
  }

  private generateMockData(schema: any): any {
    if (!schema) return {};

    switch (schema.type) {
      case 'object':
        const obj: any = {};
        if (schema.properties) {
          for (const [key, prop] of Object.entries(schema.properties)) {
            obj[key] = this.generateMockData(prop as any);
          }
        }
        return obj;
      case 'array':
        return [this.generateMockData(schema.items)];
      case 'string':
        return schema.enum ? 
          schema.enum[0] : 
          faker.lorem.words(3);
      case 'number':
      case 'integer':
        return faker.number.int({ min: 1, max: 100 });
      case 'boolean':
        return faker.datatype.boolean();
      default:
        return null;
    }
  }

  async saveTestsToFile(tests: GeneratedTest[], filename: string): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
    
    const testFile = path.join(this.outputDir, filename);
    const testContent = this.generateJestTestFile(tests);
    
    await fs.writeFile(testFile, testContent, 'utf-8');
  }

  private generateJestTestFile(tests: GeneratedTest[]): string {
    let content = `// Auto-generated API tests
// Generated on: ${new Date().toISOString()}


const baseURL = process.env.API_BASE_URL || 'http://localhost:4000';
const client = axios.create({
  baseURL,
  timeout: 30000,
});

describe('API Tests', () => {
`;

    tests.forEach(test => {
      content += `  describe('${test.name}', () => {\n`;
      content += `    ${test.description ? `// ${test.description}\n` : ''}\n`;

      test.testCases.forEach(testCase => {
        content += `    test('${testCase.name}', async () => {\n`;
        content += `      ${testCase.description ? `// ${testCase.description}\n` : ''}`;

        // Generate test code
        const requestConfig = this.generateTestRequestConfig(testCase);
        content += `      const response = await client.${test.method.toLowerCase()}(\n`;
        content += `        \`${test.endpoint.replace(/{([^}]+)}/g, '${(requestConfig.params || {})[`$1`] || `$1`}')}\`,\n`;
        
        if (testCase.request.body) {
          content += `        ${JSON.stringify(testCase.request.body, null, 8)},\n`;
        }
        
        content += `        ${JSON.stringify(requestConfig, null, 8)}\n`;
        content += `      );\n\n`;

        content += `      expect(response.status).toBe(${testCase.expectedResponse.statusCode});\n`;
        
        if (testCase.expectedResponse.body) {
          content += `      expect(response.data).toMatchObject(${JSON.stringify(testCase.expectedResponse.body, null, 8)});\n`;
        }

        content += `    });\n\n`;
      });

      content += `  });\n\n`;
    });

    content += `});
`;

    return content;
  }

  private generateTestRequestConfig(testCase: TestCase): any {
    const config: any = {
      headers: testCase.request.headers,
    };

    if (testCase.request.query) {
      config.params = testCase.request.query;
    }

    return config;
  }

  async generateTestsFromLiveAPI(baseURL: string): Promise<GeneratedTest[]> {
    // Discover endpoints by making requests to common patterns
    const commonEndpoints = [
      '/api/users',
      '/api/auth/login',
      '/api/auth/register',
      '/api/vaults',
      '/api/tokens',
      '/api/organizations',
      '/api/webhooks',
    ];

    const tests: GeneratedTest[] = [];

    for (const endpoint of commonEndpoints) {
      try {
        // Try OPTIONS request to discover supported methods
        const optionsResponse = await this.httpClient.options(endpoint);
        
        const allowHeader = optionsResponse.headers['allow'];
        if (allowHeader) {
          const methods = allowHeader.split(',').map((m: string) => m.trim().toLowerCase());
          
          for (const method of methods) {
            if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
              try {
                const response = await this.httpClient.request({
                  method,
                  url: endpoint,
                });

                const test: GeneratedTest = {
                  name: `${method.toUpperCase()} ${endpoint}`,
                  description: `Auto-discovered test for ${method.toUpperCase()} ${endpoint}`,
                  endpoint,
                  method: method.toUpperCase(),
                  testCases: [{
                    name: 'Live API Test',
                    description: 'Test based on live API response',
                    request: {
                      headers: { 'Content-Type': 'application/json' },
                    },
                    expectedResponse: {
                      statusCode: response.status,
                      body: response.data,
                    },
                  }],
                };

                tests.push(test);
              } catch (error) {
                // Skip endpoints that don't support this method
              }
            }
          }
        }
      } catch (error) {
        // Skip endpoints that don't exist
      }
    }

    return tests;
  }
}
