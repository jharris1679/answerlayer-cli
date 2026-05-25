export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function formatTable(columns, rows, { maxWidth = 120 } = {}) {
  if (!columns || columns.length === 0) {
    return "(no columns)\n";
  }

  const normalizedRows = rows || [];
  const widths = columns.map((column, index) => {
    const values = normalizedRows.map((row) => stringifyCell(row[index]));
    const max = Math.max(String(column).length, ...values.map((value) => value.length));
    return Math.min(max, Math.max(8, Math.floor(maxWidth / columns.length) - 3));
  });

  const header = renderRow(columns, widths);
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = normalizedRows.map((row) => renderRow(row, widths));

  return `${[header, separator, ...body].join("\n")}\n`;
}

export function formatQueryResult(result, format) {
  if (format === "json") {
    return formatJson(result);
  }

  if (format === "csv") {
    return formatCsv(result.columns || [], result.rows || []);
  }

  return formatTable(result.columns || [], result.rows || []);
}

export function formatList(items, columns) {
  const rows = items.map((item) => columns.map((column) => getPath(item, column.key)));
  return formatTable(columns.map((column) => column.label), rows);
}

function renderRow(row, widths) {
  return widths
    .map((width, index) => padRight(truncate(stringifyCell(row[index]), width), width))
    .join(" | ");
}

function stringifyCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function truncate(value, width) {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
}

function padRight(value, width) {
  return value + " ".repeat(Math.max(0, width - value.length));
}

function csvCell(value) {
  const text = stringifyCell(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function getPath(value, path) {
  return path.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    return current[segment];
  }, value);
}
