import { EventEmitter } from 'node:events';
export class WebSocket extends EventEmitter {
 constructor() { super(); globalThis.__memoryTestSocket = this; }
 close() {}
}
