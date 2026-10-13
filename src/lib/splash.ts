export async function renderSplash(): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create the splash image");
  ctx.fillStyle = "#101114";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#f0a030";
  ctx.fillRect(0, 0, 64, 5);
  ctx.strokeStyle = "#eceae4";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(32, 36, 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#f0a030";
  ctx.fillRect(29, 24, 6, 16);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("Could not create the splash image");
  return new Uint8Array(await blob.arrayBuffer());
}
