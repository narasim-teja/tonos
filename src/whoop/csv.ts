/**
 * RFC 4180 CSV parsing: quoted fields, doubled quotes, commas and newlines inside quotes,
 * CRLF or LF line endings, and a leading byte-order mark. Journal notes are free text, so
 * a naive split on commas would corrupt them.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) { quoted = true; fieldStarted = true; continue; }
    if (char === ",") { row.push(field); field = ""; fieldStarted = false; continue; }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = []; field = ""; fieldStarted = false;
      continue;
    }
    field += char;
    fieldStarted = true;
  }
  if (quoted) throw new Error("CSV ended inside a quoted field.");
  if (fieldStarted || field !== "" || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

/**
 * Parses a CSV with a header row into objects keyed by header. Fails when a required
 * column is missing or a row has the wrong number of fields, rather than guessing.
 */
export function parseCsvRecords(text: string, required: readonly string[], file: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const missing = required.filter(column => !header.includes(column));
  if (missing.length > 0) throw new Error(`${file}: missing column(s) ${missing.map(name => JSON.stringify(name)).join(", ")}.`);
  return rows.map((cells, index) => {
    if (cells.length !== header.length) {
      throw new Error(`${file}: row ${index + 2} has ${cells.length} fields, expected ${header.length}.`);
    }
    return Object.fromEntries(header.map((column, position) => [column, cells[position] ?? ""]));
  });
}
