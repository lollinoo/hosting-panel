"use client";

import type { RefObject } from "react";
import type { SiteFileEntryDto } from "@hosting-panel/contracts";
import { ChevronRight, File, FileArchive, FileText, Folder, Link2, Lock } from "lucide-react";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { crumbs, formatDate, formatSize, isEditable, isZip } from "@/lib/file-browser";

export function FileBreadcrumb({
  path,
  onOpen,
  headingRef,
}: {
  path: string;
  onOpen: (nextPath: string) => void;
  headingRef?: RefObject<HTMLSpanElement | null>;
}) {
  const t = useMessages().site.files;
  const list = crumbs(path);

  return (
    <nav aria-label={t.breadcrumb}>
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        <li>
          {list.length === 0 ? (
            <span
              ref={headingRef}
              tabIndex={-1}
              aria-current="page"
              className="font-medium text-foreground focus:outline-none"
            >
              {t.rootLabel}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onOpen("")}
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
            >
              {t.rootLabel}
            </button>
          )}
        </li>
        {list.map((c, idx) => {
          const isLast = idx === list.length - 1;
          return (
            <li key={c.path} className="flex items-center gap-1">
              <ChevronRight aria-hidden className="h-4 w-4 text-muted-foreground" />
              {isLast ? (
                <span
                  ref={headingRef}
                  tabIndex={-1}
                  aria-current="page"
                  className="font-medium text-foreground focus:outline-none"
                >
                  {c.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(c.path)}
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
                >
                  {c.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function EntryIcon({ entry }: { entry: SiteFileEntryDto }) {
  if (entry.kind === "dir") {
    return <Folder aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (entry.kind === "file") {
    if (isZip(entry.name)) {
      return <FileArchive aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />;
    }
    if (isEditable(entry)) {
      return <FileText aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />;
    }
    return <File aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return <Link2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

export function FileTable({
  entries,
  folderName,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  locale,
}: {
  entries: readonly SiteFileEntryDto[];
  folderName?: string;
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onToggleAll: (checked: boolean) => void;
  onOpen: (entry: SiteFileEntryDto) => void;
  locale: string;
}) {
  const t = useMessages().site.files;
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.name));
  const someSelected = entries.some((e) => selected.has(e.name));

  return (
    <Table>
      <TableCaption className="sr-only">
        {format(t.list.caption, { folder: folderName || t.rootLabel })}
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <input
              type="checkbox"
              aria-label={t.list.selectAll}
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected && !allSelected;
              }}
              onChange={(e) => onToggleAll(e.target.checked)}
              disabled={entries.length === 0}
            />
          </TableHead>
          <TableHead>{t.list.name}</TableHead>
          <TableHead className="w-32">{t.list.size}</TableHead>
          <TableHead className="w-44">{t.list.changed}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const isSelected = selected.has(entry.name);
          const openable = entry.kind === "dir" || entry.kind === "file";
          return (
            <TableRow key={entry.name} data-state={isSelected ? "selected" : undefined}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={format(t.list.select, { name: entry.name })}
                  checked={isSelected}
                  onChange={() => onToggle(entry.name)}
                />
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  <EntryIcon entry={entry} />
                  {openable ? (
                    <button
                      type="button"
                      onClick={() => onOpen(entry)}
                      className="text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
                    >
                      {entry.name}
                      {entry.kind === "dir" && <span className="sr-only"> ({t.list.folder})</span>}
                    </button>
                  ) : (
                    <span>
                      {entry.name}{" "}
                      <span className="text-xs font-normal text-muted-foreground">({t.list.shortcut})</span>
                    </span>
                  )}
                  {!entry.writable && (
                    <span className="inline-flex items-center text-muted-foreground" title={t.list.protected}>
                      <Lock aria-hidden className="h-3.5 w-3.5" />
                      <span className="sr-only">{t.list.protected}</span>
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {entry.kind === "file" ? formatSize(entry.size, locale) : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(entry.modifiedAt, locale)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
