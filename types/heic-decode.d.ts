declare module 'heic-decode' {
  const decode: (o: { buffer: Buffer | ArrayBuffer | Uint8Array }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  export default decode;
}
