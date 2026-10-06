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
    description: 'Scan a document or plan text for concurrency risk points. Use ONLY after confirming the target actually has concurrency requirements or behavior (threads, async tasks, interrupts, shared state, parallel execution). If the target is purely sequential, do not call this tool. Returns findings for keywords like thread-safe, lock-free, wait-free, data race, race condition, atomic, synchronized, mutex, semaphore, spinlock, shared variable, shared memory, reentrant, interrupt-safe, ISR, IRQ, NMI, critical section, disable_irq/enable_irq. Absolute claims (thread-safe, lock-free, no data race, interrupt-safe, ISR-safe) are flagged as errors requiring dedicated verification, and each carries suggestions naming the analysis to run instead (TSan/Helgrind, CBMC, TLA+, or RTOS-aware interrupt analysis). logicprobe does not prove concurrency safety.',
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
