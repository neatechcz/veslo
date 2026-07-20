import type { MessageWithParts, SessionErrorTurn } from "../types";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../types";

type SyntheticErrorProjectionEntry = {
  fingerprint: string;
  message: MessageWithParts;
};

type VisibleMessageProjectionCache = {
  messages: MessageWithParts[];
  syntheticErrors: Map<string, SyntheticErrorProjectionEntry>;
};

const messageID = (message: MessageWithParts) => message.info.id ?? "";

const syntheticErrorFingerprint = (errorTurn: SessionErrorTurn) => [
  errorTurn.id,
  errorTurn.text,
  errorTurn.afterMessageID ?? "",
  errorTurn.time,
  errorTurn.durableRunId ?? "",
].join("\0");

export function createVisibleMessageProjection(
  createSyntheticMessage: (sessionID: string, errorTurn: SessionErrorTurn) => MessageWithParts,
) {
  let cache: VisibleMessageProjectionCache | null = null;

  return (input: {
    source: MessageWithParts[];
    sessionID: string | null;
    errorTurns: SessionErrorTurn[];
    revertMessageID: string | null;
  }) => {
    const withoutSyntheticErrors = input.source.some((message) =>
      messageID(message).startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX),
    )
      ? input.source.filter((message) => !messageID(message).startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX))
      : input.source;
    const visible = input.revertMessageID
      ? withoutSyntheticErrors.filter((message) => {
        const id = messageID(message);
        return Boolean(id) && id < input.revertMessageID!;
      })
      : withoutSyntheticErrors;

    let next = visible;
    const syntheticErrors = new Map<string, SyntheticErrorProjectionEntry>();
    if (input.sessionID && input.errorTurns.length > 0) {
      for (const errorTurn of input.errorTurns) {
        if (next.some((message) => messageID(message) === errorTurn.id)) continue;
        const fingerprint = syntheticErrorFingerprint(errorTurn);
        const cached = cache?.syntheticErrors.get(errorTurn.id);
        const syntheticMessage = cached?.fingerprint === fingerprint
          ? cached.message
          : createSyntheticMessage(input.sessionID, errorTurn);
        syntheticErrors.set(errorTurn.id, { fingerprint, message: syntheticMessage });
        const anchorIndex = errorTurn.afterMessageID
          ? next.findIndex((message) => messageID(message) === errorTurn.afterMessageID)
          : -1;
        if (next === visible) next = visible.slice();
        if (anchorIndex === -1) next.push(syntheticMessage);
        else next.splice(anchorIndex + 1, 0, syntheticMessage);
      }
    }

    const previous = cache?.messages;
    if (previous && previous.length === next.length && previous.every((message, index) => message === next[index])) {
      next = previous;
    }
    cache = { messages: next, syntheticErrors };
    return next;
  };
}
