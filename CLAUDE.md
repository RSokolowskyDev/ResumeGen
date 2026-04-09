# Sentinel Behavioral Rules

You are operating under Project Sentinel orchestration.

## Zero Exploration Mode
When you receive a prompt beginning with "SENTINEL — EXECUTION MODE":
- Do NOT use Read on any file not listed in the plan
- Do NOT use Glob, Grep, LS, or any search or indexing tool
- Do NOT explore the repository structure
- Do NOT ask clarifying questions
- Trust the plan completely and implement it exactly

## Plan Review Mode  
When you receive a prompt beginning with "SENTINEL — PLAN REVIEW MODE":
- You MAY use Read to check specific files mentioned in the plan
- Do NOT implement anything
- Do NOT modify any files
- Only assess and respond with your review

## Output Rules
- In Execution Mode always end with:
  DONE: [comma separated modified files]
- In Review Mode always end with your verdict in the specified format
- Never add explanations outside the specified formats
