const fs = require('node:fs');

module.exports = async function monitor({ github, context, core }) {
  const { owner, repo } = context.repo;
  const run_id = context.runId;
  const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id })).data;
  const attempt = run.run_attempt;
  const started = Date.parse(attempt > 1 ? run.run_started_at : run.created_at);
  const limits = new Map([
    ['Lint & Static Analysis', 120],
    ['Backend Unit Tests', 300],
    ['Soroban Smart Contract Tests', 600],
    ['E2E User Journey (Playwright)', 900],
  ]);
  let latest = [];
  let violations = [];
  let complete = false;
  let elapsed = 0;
  try {
    while (true) {
      latest = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt,
        { owner, repo, run_id, attempt_number: attempt, per_page: 100 });
      const now = Date.now();
      elapsed = (now - started) / 1000;
      violations = [];
      for (const [name, budget] of limits) {
        const job = latest.find(item => item.name === name);
        if (!job || job.conclusion === 'skipped') continue;
        const seconds = job.started_at
          ? (Date.parse(job.completed_at || new Date(now).toISOString()) - Date.parse(job.started_at)) / 1000
          : 0;
        if (seconds >= budget || job.conclusion === 'timed_out') {
          violations.push(name + ': ' + Math.round(seconds) + 's (must be <' + budget + 's)');
        }
      }
      complete = [...limits.keys()].every(name => {
        const job = latest.find(item => item.name === name);
        return job && job.status === 'completed';
      });
      if (elapsed >= 1800) violations.push('Total: ' + Math.round(elapsed) + 's (must be <1800s)');
      if (violations.length || complete) break;
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    for (const violation of violations) core.error('Pipeline SLA violation: ' + violation);
    if (violations.length) {
      core.setFailed('Pipeline SLA failed: ' + violations.join('; '));
      // Stop unfinished jobs rather than leaving a red gate waiting for them.
      if (!complete) await github.rest.actions.cancelWorkflowRun({ owner, repo, run_id });
    }
  } finally {
    elapsed = (Date.now() - started) / 1000;
    const report = { run_id, attempt, elapsed_seconds: Math.round(elapsed),
      total_sla_seconds: 1800, hard_timeout_minutes: 45, complete, violations,
      stages: [...limits].map(([name, budget]) => {
        const job = latest.find(item => item.name === name);
        return { name, sla_seconds: budget, status: job?.status || 'unknown',
          conclusion: job?.conclusion || null, started_at: job?.started_at || null,
          completed_at: job?.completed_at || null,
          elapsed_seconds: job?.started_at && job.conclusion !== 'skipped'
            ? Math.round((Date.parse(job.completed_at || new Date().toISOString()) - Date.parse(job.started_at)) / 1000) : null };
      }) };
    fs.writeFileSync('pipeline-performance.json', JSON.stringify(report, null, 2) + '\n');
    core.setOutput('elapsed_seconds', Math.round(elapsed));
    core.setOutput('sla_passed', complete && violations.length === 0);
    const duration = (elapsed / 60).toFixed(1) + ' min';
    const color = violations.length || !complete ? '#e05d44' : '#4c1';
    fs.writeFileSync('pipeline-duration.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="190" height="20" role="img" aria-label="quality-gate duration: ' + duration + '"><rect width="115" height="20" fill="#555"/><rect x="115" width="75" height="20" fill="' + color + '"/><g fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11"><text x="57" y="14">quality-gate duration</text><text x="152" y="14">' + duration + '</text></g></svg>\n');
    const rows = report.stages.map(job => [job.name, String(job.sla_seconds), String(job.elapsed_seconds ?? 'n/a'),
      job.conclusion || job.status]);
    await core.summary.addHeading('Quality-gate duration: ' + duration)
      .addTable([[{data: 'Stage', header: true}, {data: 'SLA seconds', header: true},
        {data: 'Measured seconds', header: true}, {data: 'Result', header: true}], ...rows])
      .addRaw(violations.length ? '\nSLA violations: ' + violations.join('; ') : '\nNo measured SLA violation.')
      .write();
    core.notice('Quality-gate duration ' + duration + '; report and measured SVG badge retained as pipeline-performance artifact.');
  }
};
