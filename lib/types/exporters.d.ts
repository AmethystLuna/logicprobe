import { type LogicModelV1 } from './engine.js';
export type ExportFormat = 'uppaal' | 'tla' | 'prism' | 'spin';
export interface ExportResult {
    format: ExportFormat;
    primary: string;
    extras?: Record<string, string>;
    warnings: string[];
}
export interface ExportedModel {
    model: LogicModelV1;
    stateIds: string[];
    indexOf: Map<string, number>;
    initId: string;
    stateIdOf: Map<string, string>;
}
export declare function prepareModel(input: unknown): ExportedModel;
export declare function exportModel(input: unknown, format: ExportFormat): ExportResult;
