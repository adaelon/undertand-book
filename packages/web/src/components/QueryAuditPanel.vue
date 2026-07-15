<script setup lang="ts">
import type { QueryAudit } from "../api";

defineProps<{ audit: QueryAudit }>();
</script>

<template>
  <details class="query-audit">
    <summary>
      <span>QueryAudit</span>
      <strong>{{ audit.outcome_status }}</strong>
      <code>{{ audit.budget_version }}</code>
      <code>{{ audit.model_calls }} calls</code>
    </summary>

    <div class="audit-body">
      <section>
        <h4>Request</h4>
        <p>{{ audit.request.query }}</p>
        <p class="audit-meta">
          {{ audit.request.intent }} · {{ audit.request.targets.join(" / ") }} · {{ audit.request.anchor_lid }}
        </p>
        <ol>
          <li v-for="(obligation, index) in audit.request.obligations" :key="index">
            {{ obligation.requirement }}
          </li>
        </ol>
      </section>

      <section>
        <h4>Plan &amp; binding</h4>
        <p class="audit-meta">
          plan={{ audit.plan_gate.valid ? "valid" : "invalid" }} · probes={{ audit.probes.length }}
        </p>
        <p v-if="audit.plan_gate.missing_requirements.length">
          {{ audit.plan_gate.missing_requirements.join("; ") }}
        </p>
        <p v-if="audit.plan_gate.target_issues.length">
          {{ audit.plan_gate.target_issues.join("; ") }}
        </p>
        <ul v-if="audit.bindings.length">
          <li v-for="binding in audit.bindings" :key="binding.target">
            <strong>{{ binding.target }}</strong>
            <code>{{ binding.candidate_id }}</code>
            <span
              v-for="selection in audit.selected_bindings.filter((item) => item.candidate_id === binding.candidate_id)"
              :key="`${selection.round}:${selection.rank}`"
            >
              round {{ selection.round + 1 }} / rank {{ selection.rank }}
            </span>
            <span>{{ binding.source_lids.join(", ") }}</span>
          </li>
        </ul>
        <ul v-if="audit.candidate_fits.length">
          <li v-for="fit in audit.candidate_fits" :key="`${fit.round}:${fit.target_index}:${fit.candidate_id}`">
            <code>{{ fit.candidate_id }}</code>
            <strong>{{ fit.fit }}</strong>
            <span>{{ fit.reason }}</span>
          </li>
        </ul>
        <p v-if="audit.probes.length">probes: {{ audit.probes.join(", ") }}</p>
      </section>

      <details v-for="round in audit.candidate_rounds" :key="round.round" class="audit-round">
        <summary>Candidate round {{ round.round + 1 }}</summary>
        <div v-for="target in round.targets" :key="target.target_index" class="audit-target">
          <strong>{{ target.target }}</strong>
          <ul>
            <li v-for="candidate in target.candidates" :key="candidate.candidate_id">
              <code>{{ candidate.candidate_id }}</code>
              <span>{{ candidate.recall_strength }}</span>
              <span v-if="candidate.match_reasons.length">{{ candidate.match_reasons.join(", ") }}</span>
            </li>
          </ul>
        </div>
      </details>

      <section>
        <h4>Evidence</h4>
        <p class="audit-meta">
          {{ audit.evidence.chars_used }} chars · {{ audit.evidence.expansion_rounds }} expansion rounds ·
          overflow {{ audit.evidence.mandatory_overflow_used }}
        </p>
        <p>seed: {{ audit.evidence.seed_lids.join(", ") || "none" }}</p>
        <p>expansion: {{ audit.evidence.expansion_lids.join(", ") || "none" }}</p>
        <p v-if="audit.evidence.skipped_lids.length">skipped: {{ audit.evidence.skipped_lids.join(", ") }}</p>
        <p v-if="audit.evidence.mandatory_overflow_reasons.length">
          overflow: {{ audit.evidence.mandatory_overflow_reasons.join("; ") }}
        </p>
      </section>

      <section>
        <h4>Support &amp; gates</h4>
        <ul v-if="audit.assessments.length">
          <li v-for="assessment in audit.assessments" :key="assessment.obligation_index">
            <strong>#{{ assessment.obligation_index + 1 }} {{ assessment.verdict }}</strong>
            <span>{{ assessment.citation_lids.join(", ") || "no citation" }}</span>
            <span>{{ assessment.support_note }}</span>
          </li>
        </ul>
        <p class="audit-meta">
          binding={{ audit.structural_gate.bindings_complete }} ·
          coverage={{ audit.structural_gate.assessments_complete }} ·
          citations={{ audit.structural_gate.citations_valid }} ·
          supported={{ audit.structural_gate.all_obligations_supported }}
        </p>
      </section>
    </div>
  </details>
</template>

<style scoped>
.query-audit {
  margin-top: 0.5rem;
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.45rem;
  color: var(--steel);
  overflow-wrap: anywhere;
}

.query-audit > summary,
.audit-round > summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
  color: var(--ink);
  font-size: 0.76rem;
}

.query-audit > summary code,
.audit-body code {
  font-family: var(--mono);
  font-size: 0.72rem;
}

.audit-body {
  display: grid;
  gap: 0.7rem;
  margin-top: 0.65rem;
}

.audit-body section,
.audit-target {
  min-width: 0;
}

.audit-body h4,
.audit-body p,
.audit-body ul,
.audit-body ol {
  margin: 0.25rem 0 0;
}

.audit-body h4 {
  color: var(--ink);
  font-size: 0.75rem;
}

.audit-body ul,
.audit-body ol {
  padding-left: 1rem;
}

.audit-body li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.25rem;
}

.audit-meta {
  color: var(--stone);
  font-family: var(--mono);
  font-size: 0.7rem;
}

.audit-round {
  border-top: 1px solid var(--hairline-soft);
  padding-top: 0.4rem;
}

.audit-target {
  margin-top: 0.45rem;
}
</style>
