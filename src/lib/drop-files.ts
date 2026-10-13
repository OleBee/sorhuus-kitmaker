type DirReader = {
  readEntries: (ok: (entries: AnyEntry[]) => void, err?: (error: DOMException) => void) => void;
};

type AnyEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (file: File) => void, err?: (error: DOMException) => void) => void;
  createReader?: () => DirReader;
};

async function readAll(reader: DirReader) {
  const acc: AnyEntry[] = [];
  for (;;) {
    const batch = await new Promise<AnyEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    acc.push(...batch);
  }
  return acc;
}

async function walk(entry: AnyEntry, hint: string, out: { file: File; hint: string }[]) {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    if (!file.name.startsWith(".")) out.push({ file, hint });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const children = await readAll(entry.createReader());
    const next = `${hint} ${entry.name}`.trim();
    for (const child of children) await walk(child, next, out);
  }
}

export async function collectDropped(data: DataTransfer): Promise<{ file: File; hint: string; name: string }[]> {
  const out: { file: File; hint: string }[] = [];
  const entries: AnyEntry[] = [];
  for (const item of data.items) {
    const withEntry = item as DataTransferItem & { webkitGetAsEntry?: () => AnyEntry | null };
    const entry = withEntry.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    for (const entry of entries) await walk(entry, "", out);
  } else {
    for (const file of data.files) {
      if (!file.name.startsWith(".")) out.push({ file, hint: file.webkitRelativePath || "" });
    }
  }
  return out.map(({ file, hint }) => ({ file, hint, name: file.name }));
}
