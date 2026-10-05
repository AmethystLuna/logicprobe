/**
 * Structural mirror of the JSON value union the dsh tool registry accepts.
 *
 * `@deepseek-ai/dsh-tools` exported this type through the 0.1.x line and stopped
 * exporting it in 0.2.x, where the same type now lives in
 * `@deepseek-ai/dsh-util-values`. This package declares peer support for both
 * lines, so it cannot import the type from either one without breaking the other
 * build. Declaring the one-line union here keeps `npm run typecheck` green against
 * both, and it costs nothing at runtime: every use is a type-only cast on a value
 * this package already produced.
 *
 * Keep it structurally identical to the official type. A cast through `unknown` to
 * this alias is only a way to satisfy `defineTool`'s return-type constraint; if the
 * official union ever widens, this alias must widen with it.
 *
 * @module logicprobe-json-value
 */
export {};
