# UI Enhancement Plan - New Features Exposure

## Current UI Screens
- ✅ Dashboard (stats overview)
- ✅ Vouchers (create/list vouchers)
- ✅ Plans (manage hotspot profiles/plans)
- ✅ MikroTik Settings (configure router connection)
- ✅ Reports (reports screen - currently empty?)

## Missing UI Components

### 1. **Enhanced Voucher Creation** (Priority: HIGH)
**Location**: Vouchers screen
**Add Fields**:
- Rate Limit (e.g., "512k/1M")
- Session Timeout (e.g., "1h")
- Idle Timeout (e.g., "5m")
- Data Limit in GB (e.g., 1, 2, 5)
- Toggle: "Basic" vs "Advanced" creation

**Button**: "Create with Limits" / "Create Advanced"

### 2. **HotSpot Profiles Management** (Priority: HIGH)
**New Screen**: "HotSpot Profiles" (or tab in Plans)
**Features**:
- List existing profiles
- Create new profile with:
  - Profile name
  - Rate limit (rx/tx)
  - Session timeout
  - Idle timeout
  - Keepalive timeout
  - Login methods (checkboxes: CHAP, PAP, HTTPS, MAC, Cookie, Trial)
- Edit/delete profiles

### 3. **Walled Garden Rules** (Priority: MEDIUM)
**New Screen**: "Access Control" or "Walled Garden"
**Features**:
- List current bypass rules
- Add new rule:
  - Domain (dst_host)
  - Path (optional)
  - Action (Allow/Deny)
  - HTTP Method (optional)
- Delete rules
- Preview what's bypassed

### 4. **IP Binding Management** (Priority: MEDIUM)
**New Screen**: "Device Access" or "IP Binding"
**Features**:
- List bindings
- Add binding:
  - Source IP/Range
  - MAC Address (with validation)
  - Target IP (for NAT)
  - Type (Regular NAT / Bypass / Block)
- Delete bindings
- Visual indicator of what's blocked/bypassed

### 5. **User Statistics/Monitoring** (Priority: MEDIUM)
**New Screen**: "Monitoring" or "Active Sessions"
**Features**:
- Real-time active users list
- Per-user stats:
  - Code
  - Bytes downloaded/uploaded
  - Session uptime
  - Current limit status
- Search/filter by code
- Revoke user button

### 6. **Voucher Revocation** (Priority: HIGH)
**Location**: Vouchers table
**Changes**:
- Add "Revoke" button (soft delete, disable in MikroTik)
- Add "Delete" button (hard delete)
- Show revoked vouchers differently (strikethrough, different color)
- Show expiration date/status

### 7. **Voucher Expiration Display** (Priority: LOW)
**Location**: Vouchers table
**Changes**:
- Add "Expires" column showing date
- Add "Status" column (unused/used/expired/deactivated)
- Filter by status

## Implementation Steps

### Phase 1: Quick Wins (UI-only, no new API calls needed)
1. Add "Advanced Options" toggle in voucher creation
2. Add rate limit, timeout fields to voucher form
3. Add "Revoke" button to vouchers table
4. Display status and expiration date

### Phase 2: New Sections
1. Create "HotSpot Profiles" screen
2. Create "Walled Garden" screen
3. Create "IP Binding" screen
4. Update navigation menu

### Phase 3: Monitoring & Advanced
1. Create "Monitoring" screen
2. Add real-time statistics
3. Add user search/filter
4. Add per-user actions (stats, revoke)

## UI Wireframe Summary

```
Main Navigation (Left Sidebar)
├── Dashboard ✅
├── Vouchers ✅ (UPDATE: add revoke, expiration)
├── Plans ✅
├── HotSpot Profiles (NEW)
├── Walled Garden (NEW)
├── IP Binding (NEW)
├── Monitoring (NEW)
├── MikroTik Settings ✅
└── Reports ✅

Vouchers Screen Updates:
├── Create Section:
│   ├── Basic Mode:
│   │   └── Profile, Code Length, Quantity
│   └── Advanced Mode (NEW):
│       ├── Profile, Code Length, Quantity
│       ├── Rate Limit
│       ├── Session Timeout
│       ├── Idle Timeout
│       └── Data Limit (GB)
└── Table Columns:
    ├── Code
    ├── Status (unused/used/expired/deactivated)
    ├── Created Date
    ├── Expires
    ├── Profile
    └── Actions (Revoke, Delete, Stats)
```

## Recommendation: Start With

1. **Voucher Advanced Options** (5 mins) - Add form fields and "Create with Limits" button
2. **Voucher Revoke** (10 mins) - Add revoke endpoint call
3. **HotSpot Profiles Tab** (20 mins) - Create profile management UI
4. **Walled Garden Tab** (15 mins) - Create bypass rules UI
5. **IP Binding Tab** (15 mins) - Create binding management UI
6. **Monitoring Dashboard** (20 mins) - Show active users and stats

**Total: ~85 minutes for complete UI enhancement**

## Files to Modify
- `static/index.html` - Add new screens and form fields
- `static/app.js` - Add new functions for API calls and UI interaction
- `static/styles.css` - Add styles for new components (minimal changes)

## Notes
- Reuse existing card/form styles for consistency
- Use same message box pattern for feedback
- Follow existing color scheme and layout
- Add data validation matching backend requirements
- Include helpful hints/tooltips for advanced fields
