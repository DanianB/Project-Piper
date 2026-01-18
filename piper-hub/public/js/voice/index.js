import { startPCMStream, pushPCMChunk } from "./streamPlayer.js";

if (response.headers.get("content-type") === "application/octet-stream") {
  await startPCMStream(24000);

  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    // Uint8Array → Int16Array
    const pcm = new Int16Array(value.buffer);
    pushPCMChunk(pcm);
  }
  return;
}
