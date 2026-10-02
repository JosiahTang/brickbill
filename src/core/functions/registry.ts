import { ReportingError } from '../contracts/errors.ts';
import { validateContract } from '../contracts/validate.ts';
import type { DataRecord, RegisteredFunctionDefinition, Scalar } from '../contracts/types.ts';

export type RegisteredFunction = (records: DataRecord[], parameters: Record<string, Scalar>) => DataRecord[];

export class FunctionRegistry {
  private readonly entries = new Map<string, { definition: RegisteredFunctionDefinition; run: RegisteredFunction }>();
  register(definition: RegisteredFunctionDefinition, run: RegisteredFunction): void {
    validateContract<RegisteredFunctionDefinition>('registeredFunction', definition);
    const key = `${definition.functionId}@${definition.version}`;
    if (this.entries.has(key)) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'rule',
      message: `公共函数版本已注册：${key}` });
    this.entries.set(key, { definition: structuredClone(definition), run });
  }
  resolve(functionId: string, version: string) {
    const entry = this.entries.get(`${functionId}@${version}`);
    if (!entry) throw new ReportingError({ code: 'RULE_VERSION_NOT_FOUND', stage: 'rule',
      message: `公共数据函数 ${functionId}@${version} 未注册` });
    return entry;
  }
  execute(functionId: string, version: string, records: DataRecord[], parameters: Record<string, Scalar>): DataRecord[] {
    const entry = this.resolve(functionId, version);
    for (const [parameterId, type] of Object.entries(entry.definition.parameterSchema)) {
      const value = parameters[parameterId];
      const valid = type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'boolean' ? typeof value === 'boolean'
        : type === 'date' ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        : type === 'text' ? typeof value === 'string' : false;
      if (!valid) throw new ReportingError({ code: 'VIEW_INVALID', stage: 'rule',
        message: `函数 ${functionId} 参数 ${parameterId} 类型错误`, context: { viewId: functionId, fieldId: parameterId } });
    }
    for (const parameterId of Object.keys(parameters)) if (!Object.hasOwn(entry.definition.parameterSchema, parameterId))
      throw new ReportingError({ code: 'VIEW_INVALID', stage: 'rule',
        message: `函数 ${functionId} 不支持参数 ${parameterId}`, context: { viewId: functionId, fieldId: parameterId } });
    const output = entry.run(structuredClone(records), structuredClone(parameters));
    if (!Array.isArray(output) || output.some(record => !record || typeof record.recordId !== 'string'
      || !record.values || typeof record.values !== 'object' || Array.isArray(record.values)))
      throw new ReportingError({ code: 'VALUE_TYPE_ERROR', stage: 'rule', message: `函数 ${functionId} 返回了非法数据` });
    const seen = new Set<string>();
    for (const record of output) {
      if (seen.has(record.recordId)) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'rule',
        message: `函数 ${functionId} 输出重复记录键 ${record.recordId}`, context: { recordId: record.recordId } });
      seen.add(record.recordId);
    }
    return output;
  }
  list(): RegisteredFunctionDefinition[] {
    return [...this.entries.values()].map(entry => structuredClone(entry.definition));
  }
}
