import { BarChart3, Check, CircleAlert, FolderOpen, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { orderGiftBooks, readComparisonBookSelection, readComparisonVaults, readHiddenComparisonBooks, rememberComparisonBookSelection, rememberComparisonVaults, rememberHiddenComparisonBooks } from "./lib/comparisonVaults";
import { buildComparisonProfiles } from "./lib/comparisonProfiles";
import { canonicalizeTags, resolveCatalogTags } from "./lib/tagCatalog";
import { api } from "./lib/tauri";
import type { ComparisonBook, ComparisonBookEntry, ComparisonBookRef, ComparisonPerson, Tag } from "./types";
import { formatMoney } from "./lib/money";

function comparisonBookKey(book: Pick<ComparisonBookRef, "vaultPath" | "bookId">) {
  return `${book.vaultPath}\u001f${book.bookId}`;
}

function comparisonPersonKey(person: Pick<ComparisonPerson, "vaultPath" | "personId">) {
  return `${person.vaultPath}\u001f${person.personId}`;
}

function sourceEntryKey(entry: Pick<ComparisonBookEntry, "vaultPath" | "bookId">) {
  return `${entry.vaultPath}\u001f${entry.bookId}`;
}

function uniqueVaultPaths(paths: string[]) {
  const unique = new Map<string, string>();
  for (const path of paths) {
    const value = path.trim();
    if (value) unique.set(value.replaceAll("/", "\\").toLocaleLowerCase(), value);
  }
  return [...unique.values()];
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function EntryTags({ tags }: { tags: Tag[] }) {
  return tags.length ? <div className="tag-select">{tags.map((tag) => <span className="tag-chip" style={{ "--tag-color": tag.color } as React.CSSProperties} key={tag.id}>{tag.name}<span className="tag-swatch" /></span>)}</div> : <span className="muted">-</span>;
}

function ComparisonEntryGroups({ entries, emptyText }: { entries: ComparisonBookEntry[]; emptyText: string }) {
  const groups = useMemo(() => {
    const grouped = new Map<string, ComparisonBookEntry[]>();
    for (const entry of entries) grouped.set(sourceEntryKey(entry), [...(grouped.get(sourceEntryKey(entry)) ?? []), entry]);
    return [...grouped.values()];
  }, [entries]);
  if (!entries.length) return <span className="field-hint">{emptyText}</span>;
  return <div className="comparison-entry-groups">{groups.map((group) => {
    const first = group[0];
    return <section className="comparison-entry-group" key={sourceEntryKey(first)}><div className="comparison-entry-source"><span className="eyebrow">礼金库 / 礼金簿</span><strong>{first.vaultName} / {first.bookTitle}</strong></div><div className="table-wrap comparison-entry-table"><table><thead><tr><th>姓名</th><th>金额</th><th>支付方式</th><th>地址</th><th>备注</th><th className="tag-column">标签</th><th>回礼金额</th><th>登记日期</th></tr></thead><tbody>{group.map((entry) => <tr className="comparison-entry-row" style={{ "--entry-tag-color": entry.tags[0]?.color ?? "#a9b5b9" } as React.CSSProperties} key={entry.entryId}><td className="entry-accent-cell"><div className="person-cell"><span className="avatar">{entry.personName.slice(0, 1)}</span><strong>{entry.personName}</strong></div></td><td className="amount-cell">{formatMoney(entry.amountFen)}</td><td><span className="method-pill">{entry.paymentMethod}</span></td><td className="muted">{entry.address || "-"}</td><td className="muted note-cell">{entry.note || "-"}</td><td className="tag-column"><EntryTags tags={entry.tags} /></td><td className="amount-cell">{entry.returnGiftAmountFen ? formatMoney(entry.returnGiftAmountFen) : "-"}</td><td className="muted">{entry.receivedAt}</td></tr>)}</tbody></table></div></section>;
  })}</div>;
}

function ComparisonSourceSummary({ entries }: { entries: ComparisonBookEntry[] }) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.vaultPath}\u001f${entry.bookId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return <div className="comparison-source-summary">已查询来源：{entries.length ? entries.map((entry) => `${entry.vaultName} / ${entry.bookTitle}`).filter((source, index, all) => all.indexOf(source) === index).map((source) => { const matchingEntry = entries.find((entry) => `${entry.vaultName} / ${entry.bookTitle}` === source); const key = matchingEntry ? `${matchingEntry.vaultPath}\u001f${matchingEntry.bookId}` : source; return `${source}（${counts.get(key) ?? 0} 条）`; }).join("、") : "暂无匹配记录"}</div>;
}

function IdentityVerdict({ assessment }: { assessment: ReturnType<typeof buildComparisonProfiles>[number]["identityAssessment"] }) {
  if (!assessment) return null;
  const Icon = assessment.status === "same" ? Check : CircleAlert;
  return <span className={`identity-verdict ${assessment.status}`} title={`比较依据：${assessment.reasons.join("、")}`}><Icon size={13} strokeWidth={2.6} />{assessment.label}</span>;
}

function ComparisonPersonProfile({ profile, historyLoading, historyError, resolveTags }: { profile: ReturnType<typeof buildComparisonProfiles>[number]; historyLoading: boolean; historyError: boolean; resolveTags: (sourceVaultPath: string, tags: Tag[]) => Tag[] }) {
  const { person } = profile;
  const entries: ComparisonBookEntry[] = profile.history.map((item) => ({ vaultPath: item.vaultPath, vaultName: item.vaultName, bookId: item.bookId, bookTitle: item.bookTitle, entryId: item.entryId, personId: item.personId, personName: item.personName, address: item.personAddress, amountFen: item.totalFen, paymentMethod: item.paymentMethod, receivedAt: item.latestReceivedAt, note: item.note, returnGift: item.returnGift, returnGiftAmountFen: item.returnGiftAmountFen, tags: resolveTags(item.vaultPath, item.tags) }));
  return <article className="comparison-person-profile"><div className="comparison-profile-heading"><div className="comparison-profile-person"><span className="avatar">{person.displayName.slice(0, 1)}</span><span className="comparison-profile-name"><strong>{person.displayName}</strong><span className="comparison-profile-source">来源礼金库：{person.vaultName}</span><IdentityVerdict assessment={profile.identityAssessment} /></span></div><div className="comparison-profile-summary"><strong>平均 {formatMoney(profile.averageFen)}</strong></div></div>{!historyLoading && !historyError && <ComparisonSourceSummary entries={entries} />}<div className="comparison-profile-history">{historyLoading ? <span className="field-hint">正在读取礼金明细…</span> : historyError ? <span className="field-hint">人物明细读取失败，请重新搜索。</span> : <ComparisonEntryGroups entries={entries} emptyText="该礼金簿暂无礼金明细。" />}</div></article>;
}

export function CompareView({ vaultPath, onNotice, canEdit, bookOrder }: { vaultPath: string; onNotice: (message: string) => void; canEdit: boolean; bookOrder: readonly string[] }) {
  const client = useQueryClient();
  const [externalVaultPaths, setExternalVaultPaths] = useState<string[]>(() => readComparisonVaults());
  const [selectedBookRefs, setSelectedBookRefs] = useState<ComparisonBookRef[]>([]);
  const [hiddenBookRefs, setHiddenBookRefs] = useState<ComparisonBookRef[]>(() => readHiddenComparisonBooks(vaultPath));
  const [personQuery, setPersonQuery] = useState("");
  const [duplicateSearchRequested, setDuplicateSearchRequested] = useState(false);
  const [comparisonAddError, setComparisonAddError] = useState<string | null>(null);
  const knownVaultPaths = useMemo(() => uniqueVaultPaths([vaultPath, ...externalVaultPaths]), [externalVaultPaths, vaultPath]);
  const debouncedPersonQuery = useDebouncedValue(personQuery, 200);
  const booksQuery = useQuery({ queryKey: ["comparison-books", knownVaultPaths], queryFn: () => api.listComparisonBooks(knownVaultPaths) });
  const previousBooks = useRef<ComparisonBookRef[]>([]);
  const selectionScope = useRef<string | null>(null);
  const hiddenBookKeys = useMemo(() => new Set(hiddenBookRefs.map(comparisonBookKey)), [hiddenBookRefs]);
  const visibleBooks = useMemo(() => {
    const visible = (booksQuery.data ?? []).filter((book) => !hiddenBookKeys.has(comparisonBookKey(book)));
    return externalVaultPaths.length === 0 ? orderGiftBooks(visible, bookOrder) : visible;
  }, [booksQuery.data, hiddenBookKeys, externalVaultPaths.length, bookOrder]);
  const availableBookRefs = useMemo(() => visibleBooks.map((book) => ({ vaultPath: book.vaultPath, bookId: book.bookId })), [visibleBooks]);
  useEffect(() => {
    setHiddenBookRefs(readHiddenComparisonBooks(vaultPath));
  }, [vaultPath]);
  useEffect(() => {
    if (!booksQuery.data) return;
    const scope = vaultPath.replaceAll("/", "\\").toLocaleLowerCase();
    setSelectedBookRefs((current) => {
      const currentKeys = new Set(current.map(comparisonBookKey));
      const availableKeys = new Set(availableBookRefs.map(comparisonBookKey));
      const retained = current.filter((reference) => availableKeys.has(comparisonBookKey(reference)));
      const newlyAdded = availableBookRefs.filter((reference) => !previousBooks.current.some((previous) => comparisonBookKey(previous) === comparisonBookKey(reference)));
      const scopeChanged = selectionScope.current !== scope;
      const saved = scopeChanged ? readComparisonBookSelection(vaultPath) : null;
      const initial = scopeChanged ? (saved ? saved.filter((reference) => availableKeys.has(comparisonBookKey(reference))) : availableBookRefs) : [];
      selectionScope.current = scope;
      previousBooks.current = availableBookRefs;
      return scopeChanged ? initial : [...retained, ...newlyAdded.filter((reference) => !currentKeys.has(comparisonBookKey(reference)))];
    });
  }, [availableBookRefs, vaultPath]);
  const books = { ...booksQuery, data: visibleBooks };
  const selectedBookKey = selectedBookRefs.map(comparisonBookKey).sort().join("|");
  useEffect(() => {
    if (selectionScope.current === vaultPath.replaceAll("/", "\\").toLocaleLowerCase()) rememberComparisonBookSelection(vaultPath, selectedBookRefs);
  }, [selectedBookKey, selectedBookRefs, vaultPath]);
  useEffect(() => {
    setDuplicateSearchRequested(false);
    client.removeQueries({ queryKey: ["comparison-book-people"] });
    client.removeQueries({ queryKey: ["comparison-book-duplicate-people"] });
    client.removeQueries({ queryKey: ["comparison-person-history"] });
  }, [client, selectedBookKey]);
  const people = useQuery({ queryKey: ["comparison-book-people", selectedBookKey, debouncedPersonQuery], queryFn: () => api.searchComparisonBookPeople(selectedBookRefs, debouncedPersonQuery), enabled: Boolean(debouncedPersonQuery.trim()) && selectedBookRefs.length > 0 });
  const duplicatePeople = useQuery({ queryKey: ["comparison-book-duplicate-people", selectedBookKey], queryFn: () => api.searchComparisonDuplicateBookPeople(selectedBookRefs), enabled: duplicateSearchRequested && selectedBookRefs.length > 0 });
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags });
  const catalogTags = canonicalizeTags(tags.data ?? []);
  const resolveComparisonTags = (sourceVaultPath: string, sourceTags: Tag[]) => sourceVaultPath === vaultPath && tags.isSuccess ? resolveCatalogTags(sourceTags, catalogTags) : canonicalizeTags(sourceTags);
  const sourcePeople = duplicateSearchRequested ? duplicatePeople.data ?? [] : people.data ?? [];
  const comparisonPeople = sourcePeople.map((person) => ({ ...person, tags: resolveComparisonTags(person.vaultPath, person.tags) }));
  const searchSettled = personQuery.trim() === debouncedPersonQuery.trim();
  const resultReady = duplicateSearchRequested || (Boolean(personQuery.trim()) && searchSettled);
  const resultsLoading = duplicateSearchRequested ? duplicatePeople.isLoading : people.isLoading;
  const profilePeople = resultReady ? comparisonPeople : [];
  const history = useQuery({ queryKey: ["comparison-person-history", selectedBookKey, profilePeople.map(comparisonPersonKey)], queryFn: () => api.comparisonPersonHistory(profilePeople.map((person) => ({ vaultPath: person.vaultPath, personId: person.personId })), selectedBookRefs), enabled: profilePeople.length > 0 });
  const selectedHistory = (history.data ?? []).map((item) => ({ ...item, tags: resolveComparisonTags(item.vaultPath, item.tags) }));
  const profiles = buildComparisonProfiles(profilePeople, selectedHistory);
  const toggleBook = (book: ComparisonBook) => setSelectedBookRefs((current) => current.some((reference) => comparisonBookKey(reference) === comparisonBookKey(book)) ? current.filter((reference) => comparisonBookKey(reference) !== comparisonBookKey(book)) : [...current, { vaultPath: book.vaultPath, bookId: book.bookId }]);
  const addComparisonVaults = async () => {
    setComparisonAddError(null);
    try {
      const selected = await api.chooseComparisonVaultPaths();
      if (!selected.length) return;
      setExternalVaultPaths(rememberComparisonVaults([...externalVaultPaths, ...selected]));
      const selectedPathKeys = new Set(selected.map((path) => path.replaceAll("/", "\\").toLocaleLowerCase()));
      setHiddenBookRefs((current) => rememberHiddenComparisonBooks(vaultPath, current.filter((reference) => !selectedPathKeys.has(reference.vaultPath.replaceAll("/", "\\").toLocaleLowerCase()))));
    } catch (error) {
      setComparisonAddError(String(error).replace(/^Error:\s*/, ""));
    }
  };
  const deleteSelectedComparisonBooks = () => {
    if (!canEdit) {
      onNotice("编辑已锁定，请先解锁编辑后再删除比较礼金库");
      return;
    }
    if (!selectedBookRefs.length) return;
    const selectedKeys = new Set(selectedBookRefs.map(comparisonBookKey));
    setHiddenBookRefs((current) => rememberHiddenComparisonBooks(vaultPath, [...current, ...selectedBookRefs]));
    setSelectedBookRefs([]);
    previousBooks.current = previousBooks.current.filter((reference) => !selectedKeys.has(comparisonBookKey(reference)));
    client.removeQueries({ queryKey: ["comparison-book-people"] });
    client.removeQueries({ queryKey: ["comparison-book-duplicate-people"] });
    client.removeQueries({ queryKey: ["comparison-person-history"] });
    onNotice(`已从礼金簿概览移除 ${selectedBookRefs.length} 本礼金簿，原始文件和数据未删除`);
  };
  // These aliases retain the concise overview JSX while the source of truth is book-level.
  const selectedExternalVaultPaths = selectedBookRefs;
  const deleteSelectedComparisonVaults = deleteSelectedComparisonBooks;
  const searchDuplicates = () => { setPersonQuery(""); setDuplicateSearchRequested(true); };

  return <section className="compare-view"><div className="table-panel compare-overview"><div className="table-panel-heading"><div><strong>礼金簿概览</strong><span>{selectedBookRefs.length} / {books.data?.length ?? 0} 本已选</span></div><div className="toolbar-actions"><button className="secondary-button compact" type="button" disabled={selectedBookRefs.length < 1} onClick={searchDuplicates}><Search size={15} />搜索同名人物</button><button className="danger-button compact comparison-delete-selected" data-operation-hint="提示：只从当前比较列表删除选中来源，不删除原礼金库文件。" type="button" disabled={!canEdit || !selectedExternalVaultPaths.length} title={!canEdit ? "请先解锁编辑" : "删除选中的外部礼金库，仅从比较列表删除，不删除原文件"} onClick={deleteSelectedComparisonVaults}><Trash2 size={14} />删除选中</button><button className="secondary-button compact" type="button" onClick={() => void addComparisonVaults()}><FolderOpen size={15} />添加其他礼金库</button></div></div>{comparisonAddError && <p className="comparison-add-error" role="alert">{comparisonAddError}</p>}{books.isLoading ? <div className="table-empty">正在读取礼金簿…</div> : books.data?.length ? <div className="comparison-book-list" aria-label="已选礼金簿范围">{books.data.map((book) => { const selected = selectedBookRefs.some((reference) => comparisonBookKey(reference) === comparisonBookKey(book)); return <button className={`comparison-book-item ${selected ? "selected" : ""}`} key={comparisonBookKey(book)} type="button" aria-pressed={selected} title={selected ? "已选中，点击取消选择" : "点击选择此礼金簿"} onClick={() => toggleBook(book)}><strong>{book.title}</strong><small>{book.vaultName}</small></button>; })}</div> : <div className="table-empty"><BarChart3 size={27} /><strong>还没有可比较的礼金簿</strong><span>添加其他礼金库后，可在这里选择搜索范围。</span></div>}</div><div className="history-panel"><div className="comparison-person-search"><Search size={16} /><input value={personQuery} onChange={(event) => { setDuplicateSearchRequested(false); setPersonQuery(event.target.value); }} placeholder="输入姓名查找人物" />{personQuery && <button className="icon-button subtle" type="button" title="清除搜索" aria-label="清除搜索" onClick={() => setPersonQuery("")}><X size={14} /></button>}</div><div className="comparison-person-candidates">{selectedBookRefs.length === 0 && <span className="field-hint">请先选择至少一本礼金簿。</span>}{!duplicateSearchRequested && personQuery.trim() && people.isLoading && <span className="field-hint">正在搜索人物…</span>}{duplicateSearchRequested && duplicatePeople.isLoading && <span className="field-hint">正在搜索同名人物…</span>}{resultReady && !resultsLoading && profiles.length > 0 && <span className="comparison-result-count">{duplicateSearchRequested ? `找到 ${comparisonPeople.length} 位同名人物` : `找到 ${comparisonPeople.length} 位 ${personQuery.trim()}`}</span>}{resultReady && !resultsLoading && profiles.map((profile) => <ComparisonPersonProfile key={`${profile.person.vaultPath}\u001f${profile.person.personId}`} profile={profile} historyLoading={history.isLoading} historyError={history.isError} resolveTags={resolveComparisonTags} />)}{resultReady && !resultsLoading && profiles.length === 0 && <span className="field-hint">未找到符合条件的人物。</span>}</div></div>{books.isError && <p className="field-hint">{String(books.error)}</p>}</section>;
}
