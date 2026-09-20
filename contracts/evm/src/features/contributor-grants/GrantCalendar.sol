// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

/// @notice Gregorian UTC anniversaries for the existing individual 12/48-month grant policy.
library GrantCalendar {
    error InvalidCalendarSchedule();

    function validate(uint64 start, uint64 cliff, uint64 end) internal pure {
        bool february28 =
            cliff == anniversary(start, 1, false) && end == anniversary(start, 4, false);
        bool march1 = cliff == anniversary(start, 1, true) && end == anniversary(start, 4, true);
        if (!february28 && !march1) revert InvalidCalendarSchedule();
    }

    /// @dev For February 29 only, march1 selects the non-leap anniversary convention.
    /// The supplied cliff/end instants bind one consistent convention without mutable policy.
    function anniversary(uint64 start, uint256 yearsLater, bool march1)
        internal
        pure
        returns (uint64)
    {
        if (start > 253_276_070_399 || (yearsLater != 1 && yearsLater != 4)) {
            revert InvalidCalendarSchedule();
        }
        uint256 day = start / 1 days;
        uint256 low = 1970;
        uint256 high = 9996;
        while (low + 1 < high) {
            uint256 middle = (low + high) / 2;
            if (_yearDay(middle) <= day) low = middle;
            else high = middle;
        }
        uint256 offset = day - _yearDay(low);
        uint256 target = low + yearsLater;
        if (_leap(low) && !_leap(target)) {
            if (offset > 59 || (offset == 59 && !march1)) --offset;
        } else if (!_leap(low) && _leap(target) && offset >= 59) {
            ++offset;
        }
        return uint64((_yearDay(target) + offset) * 1 days + start % 1 days);
    }

    function _leap(uint256 year) private pure returns (bool) {
        return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    }

    function _yearDay(uint256 year) private pure returns (uint256) {
        uint256 prior = year - 1;
        // Gregorian leap days before 1970: floor(1969/4)-floor(1969/100)+floor(1969/400).
        return (year - 1970) * 365 + prior / 4 - prior / 100 + prior / 400 - 477;
    }
}
