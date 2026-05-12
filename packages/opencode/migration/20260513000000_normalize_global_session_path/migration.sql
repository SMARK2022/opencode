UPDATE `session`
SET `path` = replace(`directory`, '\', '/')
WHERE `project_id` = 'global'
  AND `path` IS NOT NULL
  AND substr(`path`, 2, 2) != ':/'
  AND substr(replace(`directory`, '\', '/'), 2, 2) = ':/'
  AND substr(replace(`directory`, '\', '/'), 4) = `path`;
