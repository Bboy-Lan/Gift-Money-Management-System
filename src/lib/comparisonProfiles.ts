import type { ComparisonPerson, ComparisonPersonHistory } from "../types";

export type IdentityAssessmentStatus = "same" | "review";

export interface IdentityAssessment {
  status: IdentityAssessmentStatus;
  label: "同一人" | "待进一步核实";
  reasons: string[];
}

export interface ComparisonProfile {
  person: ComparisonPerson;
  members: ComparisonPerson[];
  history: ComparisonPersonHistory[];
  totalFen: number;
  giftCount: number;
  averageFen: number;
  identityAssessment: IdentityAssessment | null;
}

function personKey(person: Pick<ComparisonPerson, "vaultPath" | "personId">) {
  return `${person.vaultPath}\u001f${person.personId}`;
}

function sourceKey(path: string) {
  return path.replaceAll("/", "\\").toLocaleLowerCase();
}

function normalizeComparable(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, "");
}

function tagNames(profile: Pick<ComparisonProfile, "person">) {
  return new Set(profile.person.tags.map((tag) => normalizeComparable(tag.name)).filter(Boolean));
}

function paymentMethods(profile: Pick<ComparisonProfile, "history">) {
  return new Set(profile.history.map((item) => normalizeComparable(item.paymentMethod)).filter(Boolean));
}

function compareProfilePair(left: ComparisonProfile, right: ComparisonProfile): IdentityAssessment {
  let score = 0;
  const reasons: string[] = [];
  const leftAddress = normalizeComparable(left.person.address);
  const rightAddress = normalizeComparable(right.person.address);
  if (leftAddress && rightAddress) {
    if (leftAddress === rightAddress) {
      score += 4;
      reasons.push("地址一致");
    } else {
      score -= 4;
      reasons.push("地址不一致");
    }
  }

  const leftNotes = normalizeComparable(left.person.notes);
  const rightNotes = normalizeComparable(right.person.notes);
  if (leftNotes && rightNotes) {
    if (leftNotes === rightNotes) {
      score += 1;
      reasons.push("人物备注一致");
    } else {
      score -= 1;
      reasons.push("人物备注不一致");
    }
  }

  const leftTags = tagNames(left);
  const rightTags = tagNames(right);
  if (leftTags.size && rightTags.size) {
    const sharedTags = [...leftTags].filter((tag) => rightTags.has(tag));
    if (sharedTags.length === leftTags.size && sharedTags.length === rightTags.size) {
      score += 3;
      reasons.push("标签一致");
    } else if (sharedTags.length) {
      score += 1;
      reasons.push("标签部分一致");
    } else {
      score -= 1;
      reasons.push("标签不一致");
    }
  }

  const leftMethods = paymentMethods(left);
  const rightMethods = paymentMethods(right);
  if ([...leftMethods].some((method) => rightMethods.has(method))) {
    score += 1;
    reasons.push("支付方式有交集");
  }

  return score >= 4
    ? { status: "same", label: "同一人", reasons }
    : { status: "review", label: "待进一步核实", reasons: reasons.length ? reasons : ["基础信息不足"] };
}

function buildMemberProfiles(people: ComparisonPerson[], history: ComparisonPersonHistory[]) {
  const historyByPerson = new Map<string, ComparisonPersonHistory[]>();
  for (const item of history) {
    const key = personKey(item);
    historyByPerson.set(key, [...(historyByPerson.get(key) ?? []), item]);
  }
  return people.map((person) => {
    const personHistory = historyByPerson.get(personKey(person)) ?? [];
    const sourceBooks = person.sourceBooks ?? [];
    const historyTotalFen = personHistory.reduce((total, item) => total + item.totalFen, 0);
    const historyGiftCount = personHistory.reduce((total, item) => total + item.giftCount, 0);
    const sourceTotalFen = sourceBooks.reduce((total, source) => total + source.totalFen, 0);
    const sourceGiftCount = sourceBooks.reduce((total, source) => total + source.giftCount, 0);
    const totalFen = historyGiftCount > 0 ? historyTotalFen : sourceTotalFen;
    const giftCount = historyGiftCount > 0 ? historyGiftCount : sourceGiftCount;
    return { person, members: [person], history: personHistory, totalFen, giftCount, averageFen: giftCount > 0 ? Math.floor((totalFen + Math.floor(giftCount / 2)) / giftCount) : 0, identityAssessment: null };
  });
}

function assessNameGroup(members: ComparisonProfile[]): IdentityAssessment | null {
  if (members.length === 1) {
    const bookCount = new Set([
      ...members[0].history.map((item) => item.bookId),
      ...(members[0].person.sourceBooks ?? []).map((source) => source.bookId),
    ]).size;
    return bookCount > 1 ? { status: "same", label: "同一人", reasons: ["同一人物档案出现在多本礼金簿"] } : null;
  }
  const assessments: IdentityAssessment[] = [];
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) assessments.push(compareProfilePair(members[left], members[right]));
  }
  const reasons = [...new Set(assessments.flatMap((assessment) => assessment.reasons))];
  if (assessments.every((assessment) => assessment.status === "same")) return { status: "same", label: "同一人", reasons };
  return { status: "review", label: "待进一步核实", reasons };
}

export function buildComparisonProfiles(people: ComparisonPerson[], history: ComparisonPersonHistory[]): ComparisonProfile[] {
  const members = buildMemberProfiles(people, history);
  const groups = new Map<string, ComparisonProfile[]>();
  for (const member of members) {
    const name = normalizeComparable(member.person.displayName);
    if (!name) continue;
    const key = personKey(member.person);
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  const profiles = [...groups.values()].map((group) => {
    const combinedHistory = group.flatMap((member) => member.history).sort((left, right) => right.latestReceivedAt.localeCompare(left.latestReceivedAt));
    const totalFen = combinedHistory.length
      ? combinedHistory.reduce((total, item) => total + item.totalFen, 0)
      : group.reduce((total, member) => total + member.totalFen, 0);
    const giftCount = combinedHistory.length
      ? combinedHistory.reduce((total, item) => total + item.giftCount, 0)
      : group.reduce((total, member) => total + member.giftCount, 0);
    return {
      person: group[0].person,
      members: group.map((member) => member.person),
      history: combinedHistory,
      totalFen,
      giftCount,
      averageFen: giftCount > 0 ? Math.floor((totalFen + Math.floor(giftCount / 2)) / giftCount) : 0,
      identityAssessment: assessNameGroup(group),
    };
  });
  const sameNameGroups = new Map<string, ComparisonProfile[]>();
  for (const profile of profiles) {
    const name = normalizeComparable(profile.person.displayName);
    sameNameGroups.set(name, [...(sameNameGroups.get(name) ?? []), profile]);
  }
  for (const profile of profiles) {
    const peers = (sameNameGroups.get(normalizeComparable(profile.person.displayName)) ?? [])
      .filter((candidate) => personKey(candidate.person) !== personKey(profile.person));
    if (!peers.length) continue;
    const assessments = peers.map((peer) => compareProfilePair(profile, peer));
    const reasons = [...new Set(assessments.flatMap((assessment) => assessment.reasons))];
    profile.identityAssessment = assessments.every((assessment) => assessment.status === "same")
      ? { status: "same", label: "同一人", reasons: ["不同礼金库中的基础信息一致", ...reasons] }
      : { status: "review", label: "待进一步核实", reasons: reasons.length ? reasons : ["不同礼金库中的信息存在差异"] };
  }
  return profiles.sort((left, right) => left.person.displayName.localeCompare(right.person.displayName, "zh-CN") || sourceKey(left.person.vaultPath).localeCompare(sourceKey(right.person.vaultPath)));
}
