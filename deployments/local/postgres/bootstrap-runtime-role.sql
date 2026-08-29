-- psql variables are supplied by the bootstrap-runtime-role Compose service.
-- format(%I/%L) keeps the configured role names and passwords safely quoted.
-- Each login is a member of exactly one capability group:
--   app_user     -> gameintel_runtime (worker, scheduler, publisher, operator CLI)
--   operator_user -> gameintel_operator (token-protected operator API surface)
--   public_user  -> gameintel_public (public API reads and submission intake)
-- Memberships are revoked before the intended grant so a misconfigured login
-- can never accumulate capabilities from more than one group.

SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  role_name,
  role_password
)
FROM (VALUES
  (:'app_user', :'app_password'),
  (:'operator_user', :'operator_password'),
  (:'public_user', :'public_password')
) AS roles(role_name, role_password)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
\gexec

SELECT format(
  'ALTER ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  role_name,
  role_password
)
FROM (VALUES
  (:'app_user', :'app_password'),
  (:'operator_user', :'operator_password'),
  (:'public_user', :'public_password')
) AS roles(role_name, role_password)
\gexec

-- Application logins must never be the capability group roles themselves:
-- those roles carry direct table grants that would survive any membership
-- revocation. (Generated through format() + \gexec because psql does not
-- interpolate variables inside dollar-quoted DO blocks.)
SELECT format(
  $guard$
  DO $$ BEGIN
    IF %L IN ('gameintel_runtime', 'gameintel_operator', 'gameintel_public')
      OR %L IN ('gameintel_runtime', 'gameintel_operator', 'gameintel_public')
      OR %L IN ('gameintel_runtime', 'gameintel_operator', 'gameintel_public') THEN
      RAISE EXCEPTION 'Application login names must not equal capability group role names';
    END IF;
  END $$
  $guard$,
  :'app_user',
  :'operator_user',
  :'public_user'
)
\gexec

SELECT format('REVOKE gameintel_runtime, gameintel_operator, gameintel_public FROM %I', role_name)
FROM (VALUES (:'app_user'), (:'operator_user'), (:'public_user')) AS logins(role_name)
\gexec

SELECT format('GRANT %I TO %I', group_name, role_name)
FROM (VALUES
  ('gameintel_runtime', :'app_user'),
  ('gameintel_operator', :'operator_user'),
  ('gameintel_public', :'public_user')
) AS memberships(group_name, role_name)
\gexec