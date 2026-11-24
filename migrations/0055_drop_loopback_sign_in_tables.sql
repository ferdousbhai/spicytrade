-- The pending rows of the sign-in that returned the browser to a listener on the member's
-- computer. Since 0054 an approval is collected by polling, from `agent_approvals` and
-- `broker_consents`, and no deployed code reads these. Every row was a pending attempt that
-- lapsed within minutes, so nothing is lost with them.
DROP TABLE agent_logins;
DROP TABLE broker_authorizations;
