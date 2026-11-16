// pkt-line framing: 4 hex digits of total length (header included), then the payload.
// 0000 is a flush packet, 0001 a delimiter, 0002 a response end. The largest legal packet
// is 65520 bytes including the header (git's LARGE_PACKET_MAX).

export const PKT_MAX_PAYLOAD = 65520 - 4;

export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * A strict reader over a complete request body. `next()` returns null at end of input and
 * throws on malformed framing, so a garbage body is a 400, never a crash.
 */
export class PktReader {
  private readonly buffer: Buffer;
  private offset = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  /** The unconsumed tail (a receive-pack body ends with raw pack bytes). */
  rest(): Buffer {
    const tail = this.buffer.subarray(this.offset);
    this.offset = this.buffer.length;
    return tail;
  }

  next(): Packet | null {
    if (this.offset >= this.buffer.length) return null;
    if (this.remaining < 4) throw new Error('truncated pkt-line header');
    const header = this.buffer.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (length < 4 || length > 65520) throw new Error('invalid pkt-line length');
    if (this.remaining < length) throw new Error('truncated pkt-line');
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }
}

/** Every data packet's text in a body, control packets dropped (request argument lists). */
export function dataLines(body: Buffer): string[] {
  const reader = new PktReader(body);
  const lines: string[] = [];
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}
