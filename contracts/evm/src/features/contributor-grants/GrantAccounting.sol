// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

/// @notice Fixed-allocation contributor grant accounting, with no custody or public authority.
/// @dev Internal feature policy shared by future founder/team wrappers. Explicit time is trusted
/// accounting input, not permission to choose a cancellation effective time. A future wrapper must
/// authenticate time/authority, bind recipient and reserve routing, prevent backdated creation and
/// make accounting atomic with token effects. Recorded releases/refunds do not prove payments.
/// Storage is owned by that wrapper: internal visibility does not protect against its own writes.
library GrantAccounting {
    enum Kind {
        Founder,
        TeamService
    }

    struct Terms {
        uint256 allocation;
        uint64 start;
        uint64 cliff;
        uint64 end;
        Kind kind;
        bytes32 originalPurpose;
    }

    struct Grant {
        Terms terms;
        uint256 released;
        uint256 frozenEntitlement;
        uint64 lastTransition;
        bool initialized;
        bool cancelled;
    }

    error Uninitialized();
    error AlreadyInitialized();
    error InvalidTerms();
    error PastTime();
    error InvalidRelease();
    error FounderCannotCancel();
    error AlreadyCancelled();

    /// @notice Initialize exactly once; amounts, purpose, kind and schedule have no update API.
    /// @dev Ordering is not calendar validation. Callers supply approved individual T0, T0+12-month
    /// and T0+48-month UTC instants; this library does not translate months into fixed day counts.
    function initialize(Grant storage self, Terms memory terms) internal {
        if (self.initialized) revert AlreadyInitialized();
        _validate(terms);
        self.terms = terms;
        self.initialized = true;
        // No transition has happened. Zero permits cancellation before a future grant's T0.
        // This is not a creation timestamp or a rule authorizing backdated creation.
        self.lastTransition = 0;
    }

    /// @notice Historical original curve, independent of releases and cancellation.
    /// @dev Does not reconstruct historical available debt. Malformed input is rejected even when
    /// time is outside the accrual interval, so boundary branches cannot hide invalid schedules.
    function curve(Terms memory terms, uint64 time) internal pure returns (uint256) {
        _validate(terms);
        return _curve(terms, time);
    }

    /// @notice Current ledger entitlement evaluated at time, frozen permanently on cancellation.
    /// @dev Unlike curve(), ledger queries require time >= lastTransition. A query preceding a
    /// later release is rejected explicitly, rather than subtracting that release from old vesting
    /// and underflowing. After cancellation this returns frozen debt plus already released value,
    /// not what the original curve would vest at the supplied time.
    function entitlement(Grant storage self, uint64 time) internal view returns (uint256) {
        _requireCurrent(self, time);
        return _entitlement(self, time);
    }

    /// @notice Entitlement still owed after all recorded releases, at a current ledger time.
    function available(Grant storage self, uint64 time) internal view returns (uint256) {
        return entitlement(self, time) - self.released;
    }

    /// @notice Record a positive release, without making a token transfer.
    function release(Grant storage self, uint64 time, uint256 amount) internal {
        _requireCurrent(self, time);
        uint256 owed = _entitlement(self, time) - self.released;
        if (amount == 0 || amount > owed) revert InvalidRelease();
        self.released += amount;
        self.lastTransition = time;
    }

    /// @notice Freeze team entitlement and return the one-time unvested refund instruction.
    /// @return refund Allocation less vested entitlement, NEVER allocation less released.
    /// @return originalPurpose Attribution only; neither verified reserve receipt nor budget
    /// credit.
    /// @dev Kind is checked before time and cancellation status, so founder cancellation always
    /// rejects. Unpaid vested value remains releasable; no refund-claim or budget-reset API exists.
    function cancel(Grant storage self, uint64 time)
        internal
        returns (uint256 refund, bytes32 originalPurpose)
    {
        if (!self.initialized) revert Uninitialized();
        if (self.terms.kind == Kind.Founder) revert FounderCannotCancel();
        if (self.cancelled) revert AlreadyCancelled();
        if (time < self.lastTransition) revert PastTime();
        uint256 vested = _curve(self.terms, time);
        // Monotonic transition times and the curve guarantee vested >= released.
        self.frozenEntitlement = vested;
        self.cancelled = true;
        self.lastTransition = time;
        return (self.terms.allocation - vested, self.terms.originalPurpose);
    }

    function _entitlement(Grant storage self, uint64 time) private view returns (uint256) {
        return self.cancelled ? self.frozenEntitlement : _curve(self.terms, time);
    }

    function _requireCurrent(Grant storage self, uint64 time) private view {
        if (!self.initialized) revert Uninitialized();
        if (time < self.lastTransition) revert PastTime();
    }

    function _validate(Terms memory terms) private pure {
        if (
            terms.allocation == 0 || terms.originalPurpose == bytes32(0)
                || terms.start >= terms.cliff || terms.cliff >= terms.end
        ) revert InvalidTerms();
    }

    function _curve(Terms memory terms, uint64 time) private pure returns (uint256) {
        if (time <= terms.cliff) return 0;
        if (time >= terms.end) return terms.allocation;
        uint256 duration = uint256(terms.end) - terms.cliff;
        uint256 elapsed = uint256(time) - terms.cliff;
        // floor(A*x/d) = (A/d)*x + floor((A%d)*x/d). Here 0 < x < d <= uint64.max.
        // The remainder product is < 2^128; the quotient product and final sum are <= A.
        // Thus every uint256 intermediate fits even for A = uint256.max. Branches above
        // also prevent timestamp subtraction underflow. This is schedule-specific arithmetic.
        return (terms.allocation / duration) * elapsed + ((terms.allocation % duration) * elapsed)
            / duration;
    }
}
