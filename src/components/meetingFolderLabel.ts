import type { FolderItem } from "../types/electron";
import { defaultFolderDisplayName } from "./notes/shared";
const key = (name: string) => `meetingNotification.folders.${name}`;
// Every space is the user's private one, so a location is "Private" plus the folder.
export function meetingLocationLabel(
  folderName: string | null,
  t: (key: string) => string
): string {
  return `${t(key("private"))}${folderName ? ` / ${folderName}` : ""}`;
}
export function meetingFolderLabel(folder: FolderItem, t: (key: string) => string): string {
  return meetingLocationLabel(defaultFolderDisplayName(folder, t), t);
}
