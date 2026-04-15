import { describe, expect, it } from "vite-plus/test";
import { json } from "../../src/sources/text.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const patient = {
  id: 1,
  first_name: "Alice",
  last_name: "Smith",
  dob: "1985-03-12",
  medications: ["metformin", "lisinopril"],
  allergies: ["penicillin"],
};

// ---------------------------------------------------------------------------
// describe()
// ---------------------------------------------------------------------------

describe("source.json() — describe()", () => {
  it("includes top-level keys", () => {
    const adapter = json(patient);
    const desc = adapter.describe();
    expect(desc).toContain("id");
    expect(desc).toContain("first_name");
    expect(desc).toContain("medications");
    expect(desc).toContain("allergies");
  });

  it("includes token count", () => {
    const adapter = json(patient);
    const desc = adapter.describe();
    expect(desc).toMatch(/~\d+ token/);
  });

  it("labels plain objects as 'JSON object' with keys", () => {
    const adapter = json(patient);
    const desc = adapter.describe();
    expect(desc).toContain("JSON object");
    expect(desc).toContain("with keys:");
  });

  it("labels arrays as 'JSON array'", () => {
    const adapter = json([1, 2, 3]);
    const desc = adapter.describe();
    expect(desc).toContain("JSON array");
    expect(desc).not.toContain("JSON object");
    expect(desc).not.toContain("no top-level keys");
  });

  it("labels null as 'JSON primitive'", () => {
    const adapter = json(null);
    const desc = adapter.describe();
    expect(desc).toContain("JSON primitive");
    expect(desc).not.toContain("JSON object");
  });

  it("labels numbers as 'JSON primitive'", () => {
    const adapter = json(42);
    const desc = adapter.describe();
    expect(desc).toContain("JSON primitive");
    expect(desc).not.toContain("JSON object");
  });

  it("caps key list at 20 and appends '… and N more' for large objects", () => {
    const large: Record<string, number> = {};
    for (let i = 0; i < 50; i++) large[`key_${i}`] = i;
    const adapter = json(large);
    const desc = adapter.describe();
    // Should mention some keys but not all 50
    expect(desc).toContain("… and 30 more");
    // Should not contain key_20 (the 21st key, beyond the cap)
    expect(desc).not.toContain("key_20");
  });

  it("shows all keys when count is exactly at the cap", () => {
    const exact: Record<string, number> = {};
    for (let i = 0; i < 20; i++) exact[`k${i}`] = i;
    const adapter = json(exact);
    const desc = adapter.describe();
    expect(desc).not.toContain("more");
    expect(desc).toContain("k19");
  });
});

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

describe("source.json() — read()", () => {
  it("returns pretty-printed JSON", async () => {
    const adapter = json(patient);
    const content = await adapter.read!("text");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(patient);
    // Should be pretty-printed (has newlines)
    expect(content).toContain("\n");
  });

  it("serializes nested structures", async () => {
    const adapter = json({ a: { b: { c: 1 } } });
    const content = await adapter.read!("text");
    expect(JSON.parse(content)).toEqual({ a: { b: { c: 1 } } });
  });

  it("handles circular references without throwing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = { id: 1 };
    circular.self = circular;
    const adapter = json(circular);
    // Should not throw — safe-stable-stringify handles circular refs
    const content = await adapter.read!("text");
    expect(content).toContain('"id"');
  });
});

// ---------------------------------------------------------------------------
// Delegation to source.text (chunking behavior)
// ---------------------------------------------------------------------------

describe("source.json() — chunking delegation", () => {
  it("small objects: no list, no search", () => {
    const adapter = json(patient);
    expect("list" in adapter).toBe(false);
    expect("search" in adapter).toBe(false);
    expect("read" in adapter).toBe(true);
  });

  it("large objects: list, read, and search are available", () => {
    // Build a large object that exceeds the default 4000-token threshold
    const large: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) {
      large[`key_${i}`] = `value_${i} `.repeat(5);
    }
    const adapter = json(large);
    expect("list" in adapter).toBe(true);
    expect("search" in adapter).toBe(true);
    expect("read" in adapter).toBe(true);
  });

  it("describe() still includes access-pattern note when chunked", () => {
    const large: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) {
      large[`key_${i}`] = `value_${i} `.repeat(5);
    }
    const adapter = json(large, { chunkThreshold: 10 });
    const desc = adapter.describe();
    // Should mention both the JSON keys summary and the chunking access note
    expect(desc).toContain("JSON object");
    expect(desc).toContain("search_source");
  });

  it("chunk: false option forces blob mode even for large input", () => {
    const large: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) {
      large[`key_${i}`] = `value_${i} `.repeat(5);
    }
    const adapter = json(large, { chunk: false });
    expect("list" in adapter).toBe(false);
    expect("search" in adapter).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// source.json vs source.text equivalence
// ---------------------------------------------------------------------------

describe("source.json() — equivalence to source.text(stringify(value))", () => {
  it("read() round-trips the value through JSON", async () => {
    const adapter = json(patient);
    const content = await adapter.read!("text");
    // safe-stable-stringify sorts keys alphabetically (stable output for hashing),
    // so we compare parsed values rather than raw strings.
    expect(JSON.parse(content)).toEqual(patient);
    expect(content).toContain("\n"); // pretty-printed
  });
});
