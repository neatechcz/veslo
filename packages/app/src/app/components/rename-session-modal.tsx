import RenameModal from "./rename-modal";

export type RenameSessionModalProps = {
  open: boolean;
  title: string;
  busy: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
};

export default function RenameSessionModal(props: RenameSessionModalProps) {
  return (
    <RenameModal
      {...props}
      titleKey="session.rename_title"
      descriptionKey="session.rename_description"
      labelKey="session.rename_label"
      placeholderKey="session.rename_placeholder"
    />
  );
}
