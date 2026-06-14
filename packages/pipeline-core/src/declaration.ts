import { pipelineError } from "./errors.js";

export const ASYNC_PIPELINE_DECLARATION = Symbol.for("@async/pipeline.declaration");
export const ASYNC_PIPELINE_DECLARATION_VERSION = 1;

export type DeclarationKind = string;

export interface DeclarationMetadata {
  kind: DeclarationKind;
  version: number;
}

export type BrandedDeclaration<T extends object> = T & {
  readonly [ASYNC_PIPELINE_DECLARATION]?: DeclarationMetadata;
};

export function brandDeclaration<T extends object>(value: T, kind: DeclarationKind): BrandedDeclaration<T> {
  const existing = readDeclaration(value);
  if (existing) {
    if (existing.kind !== kind) {
      throw pipelineError(
        "ASYNC_PIPELINE_DECLARATION_KIND_MISMATCH",
        `Cannot brand declaration kind "${kind}" over existing kind "${existing.kind}".`
      );
    }
    assertSupportedDeclaration(value, kind);
    return value as BrandedDeclaration<T>;
  }

  Object.defineProperty(value, ASYNC_PIPELINE_DECLARATION, {
    value: { kind, version: ASYNC_PIPELINE_DECLARATION_VERSION },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return value as BrandedDeclaration<T>;
}

export function readDeclaration(value: unknown): DeclarationMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const metadata = (value as { [ASYNC_PIPELINE_DECLARATION]?: unknown })[ASYNC_PIPELINE_DECLARATION];
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const kind = (metadata as { kind?: unknown }).kind;
  const version = (metadata as { version?: unknown }).version;
  if (typeof kind !== "string" || typeof version !== "number") return undefined;
  return { kind, version };
}

export function hasDeclarationKind(value: unknown, kind: DeclarationKind): boolean {
  const metadata = readDeclaration(value);
  return metadata?.kind === kind;
}

export function assertSupportedDeclaration(value: unknown, expectedKind?: DeclarationKind): DeclarationMetadata | undefined {
  const metadata = readDeclaration(value);
  if (!metadata) return undefined;
  if (metadata.version !== ASYNC_PIPELINE_DECLARATION_VERSION) {
    throw pipelineError(
      "ASYNC_PIPELINE_DECLARATION_VERSION_UNSUPPORTED",
      `Unsupported async-pipeline declaration version ${metadata.version} for "${metadata.kind}". Supported version: ${ASYNC_PIPELINE_DECLARATION_VERSION}.`
    );
  }
  if (expectedKind !== undefined && metadata.kind !== expectedKind) {
    throw pipelineError(
      "ASYNC_PIPELINE_DECLARATION_KIND_MISMATCH",
      `Expected async-pipeline declaration kind "${expectedKind}", received "${metadata.kind}".`
    );
  }
  return metadata;
}
