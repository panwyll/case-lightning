-- The standard report-on-title document lost its plan-tier suffix; rows seeded under the old name follow.
update doc_template set name = 'Report on title', description = 'Report to the client on the title and searches; the narrative sections are written by the AI from the file.' where name = 'Report on title (premium AI)';
