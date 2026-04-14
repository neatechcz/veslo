export type BootstrapLocalRecoveryCause =
  | { kind: "connect-returned-false" }
  | { kind: "connect-threw"; error: unknown };

export async function connectOrRecoverLocalBootstrap(operations: {
  connect: () => Promise<boolean>;
  startHost: () => Promise<boolean>;
  onRecover?: (cause: BootstrapLocalRecoveryCause) => void;
}) {
  try {
    if (await operations.connect()) {
      return true;
    }
    operations.onRecover?.({ kind: "connect-returned-false" });
  } catch (error) {
    operations.onRecover?.({ kind: "connect-threw", error });
  }

  return await operations.startHost();
}
