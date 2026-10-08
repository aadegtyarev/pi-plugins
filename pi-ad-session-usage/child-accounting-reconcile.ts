import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { conflictsWith, identityForChild } from "./child-accounting-evidence.ts";
import { childEvidenceForEntry, type ChildEvidenceRecord } from "./child-accounting-source.ts";

interface Group {
  records: ChildEvidenceRecord[];
  aliases: Set<string>;
  signatures: Set<string>;
  stable: boolean;
  ambiguous: boolean;
}
export interface ReconciledChildren {
  recognized: boolean;
  records: ChildEvidenceRecord[];
  ambiguous: boolean;
}

export function reconcileChildEvidence(branch: SessionEntry[]): ReconciledChildren {
  const groups: Group[] = [];
  const aliases = new Map<string, Group>();
  const signatures = new Map<string, Set<Group>>();
  let recognized = false;
  let ambiguous = false;
  const attach = (group: Group, record: ChildEvidenceRecord, identity: ReturnType<typeof identityForChild>) => {
    group.records.push(record);
    group.stable ||= identity.stable;
    for (const alias of identity.aliases) { group.aliases.add(alias); aliases.set(alias, group); }
    group.signatures.add(identity.signature);
    const found = signatures.get(identity.signature) ?? new Set<Group>();
    found.add(group);
    signatures.set(identity.signature, found);
    for (const old of group.records) if (old !== record && conflictsWith(old, record)) group.ambiguous = true;
  };
  for (let entryIndex = 0; entryIndex < branch.length; entryIndex++) {
    const batch = childEvidenceForEntry(branch[entryIndex]!);
    if (!batch.recognized) continue;
    recognized = true;
    for (const record of batch.records) {
      if (!record.result) {
        groups.push({ records: [record], aliases: new Set(), signatures: new Set(), stable: false, ambiguous: false });
        continue;
      }
      const identity = identityForChild(record);
      const matches = new Set<Group>();
      for (const alias of identity.aliases) { const group = aliases.get(alias); if (group) matches.add(group); }
      for (const group of signatures.get(identity.signature) ?? []) {
        const crossFormatOverlap = group.records.some((prior) => prior.source !== record.source) && (!identity.stable || !group.stable);
        const sameLegacyFallback = record.source === "legacy" && !identity.stable && group.records.every((prior) => {
          const priorIdentity = identityForChild(prior);
          return prior.source === "legacy" && !priorIdentity.stable && priorIdentity.legacySignature === identity.legacySignature;
        });
        if (crossFormatOverlap || sameLegacyFallback) matches.add(group);
      }
      let target = [...matches][0];
      if (!target) {
        target = { records: [], aliases: new Set(), signatures: new Set(), stable: false, ambiguous: false };
        groups.push(target);
      } else if (!identity.stable || !target.stable) {
        target.ambiguous = true;
      }
      for (const other of [...matches].slice(1)) {
        for (const old of other.records) if (target.records.some((prior) => conflictsWith(prior, old))) target.ambiguous = true;
        target.records.push(...other.records);
        target.stable ||= other.stable;
        target.ambiguous ||= other.ambiguous;
        for (const alias of other.aliases) { target.aliases.add(alias); aliases.set(alias, target); }
        for (const signature of other.signatures) {
          target.signatures.add(signature);
          const found = signatures.get(signature) ?? new Set<Group>();
          found.delete(other); found.add(target); signatures.set(signature, found);
        }
        groups.splice(groups.indexOf(other), 1);
      }
      attach(target, record, identity);
    }
  }
  const records = groups.map((group) => {
    ambiguous ||= group.ambiguous;
    return group.records.find((record) => record.source === "async") ?? group.records[0]!;
  });
  return { recognized, records, ambiguous };
}
