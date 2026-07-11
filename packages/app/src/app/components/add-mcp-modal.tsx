import { Show, createSignal } from "solid-js";
import { Loader2, Plus } from "lucide-solid";
import Button from "./button";
import TextInput from "./text-input";
import ModalShell from "./modal-shell";
import ModalHeader from "./modal-header";
import ModalFooter from "./modal-footer";
import ModalError from "./modal-error";
import type { McpDirectoryInfo } from "../constants";
import { parseLocalCommandInput } from "../mcp";
import { t, type Language } from "../../i18n";

export type AddMcpModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: McpDirectoryInfo) => void;
  busy: boolean;
  isRemoteWorkspace: boolean;
  language: Language;
};

export default function AddMcpModal(props: AddMcpModalProps) {
  const tr = (key: string) => t(key, props.language);

  const [name, setName] = createSignal("");
  const [serverType, setServerType] = createSignal<"remote" | "local">("remote");
  const [url, setUrl] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [oauthRequired, setOauthRequired] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const reset = () => {
    setName("");
    setServerType("remote");
    setUrl("");
    setCommand("");
    setOauthRequired(false);
    setError(null);
  };

  const handleClose = () => {
    reset();
    props.onClose();
  };

  const handleSubmit = () => {
    setError(null);

    const trimmedName = name().trim();
    if (!trimmedName) {
      setError(tr("mcp.name_required"));
      return;
    }

    if (serverType() === "remote") {
      const trimmedUrl = url().trim();
      if (!trimmedUrl) {
        setError(tr("mcp.url_or_command_required"));
        return;
      }

      props.onAdd({
        name: trimmedName,
        description: "",
        type: "remote",
        url: trimmedUrl,
        oauth: oauthRequired(),
      });
    } else {
      const trimmedCommand = command().trim();
      if (!trimmedCommand) {
        setError(tr("mcp.url_or_command_required"));
        return;
      }

      props.onAdd({
        name: trimmedName,
        description: "",
        type: "local",
        command: parseLocalCommandInput(trimmedCommand),
        oauth: false,
      });
    }

    handleClose();
  };

  return (
    <ModalShell open={props.open} onClose={handleClose}>
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-6">
        <ModalHeader
          title={tr("mcp.add_modal_title")}
          description={tr("mcp.add_modal_subtitle")}
          showClose={false}
        />
        <button
          type="button"
          class="rounded-md p-2 text-[var(--dls-button-ghost)] transition-colors hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
          onClick={handleClose}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div class="px-6 py-5 space-y-4">
        <TextInput
          label={tr("mcp.server_name")}
          placeholder={tr("mcp.server_name_placeholder")}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          autofocus
        />

        <div>
          <div class="mb-1 text-xs font-medium text-dls-secondary">{tr("mcp.server_type")}</div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                serverType() === "remote"
                  ? "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text"
                  : "border-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
              }`}
              onClick={() => setServerType("remote")}
            >
              {tr("mcp.type_remote")}
            </button>
            <button
              type="button"
              disabled={props.isRemoteWorkspace}
              class={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                serverType() === "local"
                  ? "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text"
                  : "border-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
              } ${props.isRemoteWorkspace ? "opacity-50 cursor-not-allowed" : ""}`}
              onClick={() => {
                if (props.isRemoteWorkspace) return;
                setServerType("local");
              }}
            >
              {tr("mcp.type_local_cmd")}
            </button>
          </div>
          <Show when={props.isRemoteWorkspace}>
            <div class="mt-2 text-[11px] text-dls-secondary">{tr("mcp.remote_workspace_url_hint")}</div>
          </Show>
        </div>

        <Show when={serverType() === "remote"}>
          <div class="space-y-3">
            <TextInput
              label={tr("mcp.server_url")}
              placeholder={tr("mcp.server_url_placeholder")}
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
            <label class="flex items-center gap-2 text-xs text-dls-secondary">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border border-dls-border"
                checked={oauthRequired()}
                onChange={(event) => setOauthRequired(event.currentTarget.checked)}
              />
              {tr("mcp.oauth_optional_label")}
            </label>
          </div>
        </Show>

        <Show when={serverType() === "local"}>
          <TextInput
            label={tr("mcp.server_command")}
            placeholder={tr("mcp.server_command_placeholder")}
            hint={tr("mcp.server_command_hint")}
            value={command()}
            onInput={(e) => setCommand(e.currentTarget.value)}
          />
        </Show>

        <ModalError error={error()} />
      </div>

      <ModalFooter bordered>
        <Button variant="ghost" onClick={handleClose}>
          {tr("mcp.auth.cancel")}
        </Button>
        <Button variant="outline" onClick={handleSubmit} disabled={props.busy}>
          <Show when={props.busy} fallback={<Plus size={16} />}>
            <Loader2 size={16} class="animate-spin" />
          </Show>
          {tr("mcp.add_server_button")}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
