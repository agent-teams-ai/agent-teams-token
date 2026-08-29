# Unsigned deployment-plan source boundary

This feature owns deterministic deployment identity, local fee estimation and
independent verification. It cannot read private keys, sign transactions or
broadcast RPC methods. Production code follows `domain <- application <-
adapters <- composition`.
