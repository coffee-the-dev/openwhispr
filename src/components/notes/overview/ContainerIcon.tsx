import { Folder, Lock } from "../../icons";
import type { FolderItem } from "../../../types/electron";

interface ContainerIconProps {
  folder: FolderItem | null;
  size?: number;
}

export function ContainerIcon({ folder, size = 14 }: ContainerIconProps) {
  if (folder) {
    return <Folder size={size} className="text-muted-foreground/70 shrink-0" />;
  }
  return <Lock size={size} className="text-muted-foreground/70 shrink-0" />;
}
