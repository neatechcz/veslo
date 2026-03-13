export const extractFilesFromDataTransfer = (transfer: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] => {
  if (!transfer) return [];

  const directFiles = Array.from((transfer.files ?? []) as ArrayLike<File>).filter((file): file is File => Boolean(file));
  if (directFiles.length) return directFiles;

  const itemFiles: File[] = [];
  const items = Array.from((transfer.items ?? []) as ArrayLike<DataTransferItem>);
  for (const item of items) {
    if (!item || item.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (file) itemFiles.push(file);
  }

  return itemFiles;
};
