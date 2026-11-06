# KAN-211: Deployment control ownership

Source: https://synapse21.atlassian.net/browse/KAN-211 (parent KAN-208).

AI & routing owns retained controls affecting deployed AI execution, provider/model routing, fallbacks, availability, token parameters and existing live costs. Development owns experimental choices and comparative spending. Trace every Accuracy setting to actual readers/writers, classify its effects, and document its destination or justified retirement. Reuse existing controls; fill only confirmed gaps.

Preserve effective live values/defaults, validation, provider availability/errors, AI-off enforcement, authorization and change history. Never copy Accuracy legacy routes into customer routes or promote experiment settings. Preserve shared credential status and cost semantics without exposing secrets. Development edits cannot change live configuration. Add no speculative spending system or configuration surface. Retain historical tables and artifacts; no data migration/deletion.

Verify with disposable persistence and scripted providers: live control save reaches intended customer stage, unrelated stages stay unchanged, Development settings leave live records unchanged. Test invalid parameters, unavailable credentials, unauthorized edits; run targeted route, AI-off, cost and Admin/browser checks.

User delivery decision: branch from and target admin-accuracy-removal, which contains prerequisite KAN-209. Leave the PR open.
