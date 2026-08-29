-- psql variables are supplied by the bootstrap-runtime-role Compose service.
-- format(%I/%L) keeps the configured role name and password safely quoted.
SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_user',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format(
  'ALTER ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_user',
  :'app_password'
)
\gexec

SELECT format('GRANT gameintel_runtime TO %I', :'app_user')
\gexec
