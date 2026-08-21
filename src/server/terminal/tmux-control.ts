type TmuxControlValue = string | Uint8Array;

export function decodeTmuxControlValue(value: TmuxControlValue, decoder = new TextDecoder()): string {
  return decoder.decode(tmuxControlBytes(value), { stream: true });
}

export function parseTmuxControlOutput(
  line: string | Buffer,
  paneId: string,
  decoder = new TextDecoder()
): string | undefined {
  const prefix = `%output ${paneId} `;
  if (Buffer.isBuffer(line)) {
    const prefixBytes = Buffer.from(prefix, 'ascii');
    return line.subarray(0, prefixBytes.length).equals(prefixBytes)
      ? decodeTmuxControlValue(line.subarray(prefixBytes.length), decoder)
      : undefined;
  }
  return line.startsWith(prefix) ? decodeTmuxControlValue(line.slice(prefix.length), decoder) : undefined;
}

function tmuxControlBytes(value: TmuxControlValue): Uint8Array {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (
      source[index] === 0x5c &&
      index + 3 < source.length &&
      source[index + 1] >= 0x30 &&
      source[index + 1] <= 0x37 &&
      source[index + 2] >= 0x30 &&
      source[index + 2] <= 0x37 &&
      source[index + 3] >= 0x30 &&
      source[index + 3] <= 0x37
    ) {
      bytes.push(Number.parseInt(source.subarray(index + 1, index + 4).toString('ascii'), 8));
      index += 3;
      continue;
    }
    bytes.push(source[index]);
  }
  return Uint8Array.from(bytes);
}
