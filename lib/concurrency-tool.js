import { defineTool } from '@deepseek-ai/dsh-tools';
import { runConcurrencyScan } from './concurrency.js';
export const LOGICPROBE_CONCURRENCY_SCAN_TOOL_NAME = 'logicprobe_concurrency_scan';
/**
 * Model-visible DSH tool that mines design documents/plans for concurrency-related
 * claims and risk keywords. It does not prove concurrency safety; it flags terms
 * such as "thread-safe", "lock-free", "race condition", "atomic", "mutex", etc.,
 * so the model can either provide dedicated evidence or mark the claim unverified.
 */
export const logicProbeConcurrencyScanTool = defineTool({
    name: LOGICPROBE_CONCURRENCY_SCAN_TOOL_NAME,
    description: 'Scan a document or plan text for concurrency risk points. Returns findings for keywords like thread-safe, lock-free, data race, race condition, atomic, synchronized, mutex, semaphore, shared variable, reentrant, interrupt-safe. Absolute claims (thread-safe, lock-free, no data race) are flagged as errors requiring dedicated verification.',
    parameters: {
        text: {
            type: 'string',
            required: true,
            description: 'Document or plan text to scan for concurrency-related claims.',
        },
    },
    output: {
        schema: {
            type: 'json',
            description: 'Concurrency scan report with findings and summary.',
        },
        render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
        return runConcurrencyScan(args.text);
    },
});
