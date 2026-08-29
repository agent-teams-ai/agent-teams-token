# Local Solana fixture source boundary

This feature owns the valueless classic SPL Token lifecycle on an isolated local
Agave validator. Production code follows `domain <- application <- adapters <-
composition`; public networks, production authorities and CCIP are outside this
boundary.
