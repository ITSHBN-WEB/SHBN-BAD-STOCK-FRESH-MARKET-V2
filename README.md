# DRS - Disposal Record System

Static site (GitHub Pages) + Supabase.

- index.html        page structure
- css/styles.css    all styles
- js/app.js         all application code
- assets/           images
- sql/              one-time Supabase scripts (not served, for reference)

After changing css/js, bump the ?v= number in index.html so phones load the new files.


## Accounts and login
Run `sql/accounts-schema.sql` in Supabase once. Starting passwords: SHBN1234, SHPL1234, SHPP1234, HO1234 and MG1133 (Management). Users change their own password from the user menu; Management can reset any account to its default in Admin > Accounts. Sessions end after 30 minutes of inactivity.
Note: the database tables are still readable by the public anon key (RLS "anon allow"), so login controls what the app shows, not what a determined person could query directly.
