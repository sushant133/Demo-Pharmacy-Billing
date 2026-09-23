import ExcelJS from "exceljs";
import { matchColumn, rowsToCsv } from "@/lib/medicine-import";

/**
 * An Excel workbook to the CSV text the importer reads.
 *
 * Kept apart from `medicine-import.ts` so that file stays free of the Excel
 * library and safe to import from the browser. The workbook is only turned
 * into text here; every check still happens in `parseMedicineCsv`, so a row
 * from Excel is judged exactly as the same row pasted in would be.
 */

/** A cell's value as the user sees it in Excel. */
function cellText(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return value;

  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
  if ("text" in value) return value.text;
  if ("error" in value) return "";
  return "";
}

/**
 * Read the sheet that holds the medicines.
 *
 * A workbook often carries a cover or notes sheet first, so the sheet taken is
 * the first whose opening rows name a medicine column; failing that, the first
 * sheet with anything in it.
 */
export async function xlsxToCsv(data: ArrayBuffer): Promise<{ csv: string; sheet: string }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data);
  } catch {
    throw new Error(
      "That file could not be read as an Excel workbook. Save it as .xlsx (or CSV) and try again.",
    );
  }

  const grids = workbook.worksheets.map((sheet) => {
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: unknown[] = [];
      for (let column = 1; column <= sheet.columnCount; column++) {
        cells.push(cellText(row.getCell(column).value));
      }
      // Trailing blanks are formatting, not columns.
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) rows.push(cells);
    });
    return { name: sheet.name, rows };
  });

  const namesMedicine = (rows: unknown[][]) =>
    rows
      .slice(0, 10)
      .some((row) => row.some((cell) => matchColumn(String(cell)) === "name"));

  const chosen =
    grids.find((grid) => namesMedicine(grid.rows)) ??
    grids.find((grid) => grid.rows.length > 0);

  if (!chosen) throw new Error("That workbook has no rows in it.");

  return { csv: rowsToCsv(chosen.rows), sheet: chosen.name };
}
