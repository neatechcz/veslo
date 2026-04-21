import RenameModal from "./rename-modal";

export type RenameWorkspaceModalProps = {
  open: boolean;
  title: string;
  busy: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
};

export default function RenameWorkspaceModal(props: RenameWorkspaceModalProps) {
  return (
    <RenameModal
      {...props}
      titleKey="workspace.rename_title"
      descriptionKey="workspace.rename_description"
      labelKey="workspace.rename_label"
      placeholderKey="workspace.rename_placeholder"
    />
  );
}
