/**
 * ESC/POS bytes for a 80mm Bluetooth / Wi-Fi thermal printer.
 *
 * Text only (CP437-safe ASCII). Nepali on the paper comes from the HTML
 * print path, which rasterises the receipt.
 */

const ESC = 0x1b;
const GS = 0x1d;

function encodeAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i] = code < 128 ? code : 63; // '?'
  }
  return bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function encodeEscPos(lines: string[]): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array([ESC, 0x40]), // init
    new Uint8Array([ESC, 0x74, 0x00]), // CP437
    new Uint8Array([ESC, 0x61, 0x01]), // centre the header
    new Uint8Array([ESC, 0x21, 0x08]), // emphasised
  ];

  const header = lines.slice(0, 2);
  const rest = lines.slice(2);
  parts.push(encodeAscii(header.join("\n") + "\n"));
  parts.push(new Uint8Array([ESC, 0x21, 0x00])); // normal
  parts.push(new Uint8Array([ESC, 0x61, 0x00])); // left
  parts.push(encodeAscii(rest.join("\n") + "\n\n\n"));
  parts.push(new Uint8Array([GS, 0x56, 0x01])); // partial cut
  return concat(parts);
}
