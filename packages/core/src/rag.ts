import type { Chunk, RagItems } from "./types.ts";

function isChunk(value: unknown): value is Chunk {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string"
  );
}

function isChunkArray(values: unknown[]): values is Chunk[] {
  return values.every(isChunk);
}

export function isRagItems(value: unknown): value is RagItems {
  return (
    typeof value === "object" &&
    value !== null &&
    "_type" in value &&
    value._type === "rag" &&
    "items" in value &&
    Array.isArray(value.items) &&
    isChunkArray(value.items)
  );
}

export function createRagItems(promise: Promise<Chunk[]>): Promise<RagItems>;
export function createRagItems<T>(
  promise: Promise<T[]>,
  normalize: (item: T) => Chunk,
): Promise<RagItems>;

export async function createRagItems<T>(
  promise: Promise<T[] | Chunk[]>,
  normalize?: (item: T) => Chunk,
): Promise<RagItems> {
  const items = await promise;

  if (normalize) {
    const normalizedItems = items.map((item) => normalize(item as T));

    if (!isChunkArray(normalizedItems)) {
      throw new TypeError(
        "budge.source.rag() normalize() must return Chunk objects with string content.",
      );
    }

    return {
      _type: "rag",
      items: normalizedItems,
    };
  }

  if (!isChunkArray(items)) {
    throw new TypeError(
      "budge.source.rag() requires either Chunk[] input or a normalize function.",
    );
  }

  return { _type: "rag", items };
}
