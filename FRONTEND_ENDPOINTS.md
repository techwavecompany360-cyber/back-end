# Backend API Endpoints - Frontend Integration Guide

## Base URL

```
http://localhost:3000/management
```

## Accommodation Registration Endpoint

### 1. Register New Accommodation

**Endpoint:** `POST /accommodations/register`

**Description:** Register a new accommodation with business documents and payment details.

#### Request Headers

```
Content-Type: application/json
```

#### Request Body

```json
{
  "name": "Sunset Beach Resort",
  "description": "Luxury beachfront accommodation with modern amenities",
  "location": "Dar es Salaam, Tanzania",
  "type": "Hotel",
  "amenities": ["WiFi", "Pool", "Restaurant", "Spa", "Gym"],
  "otherImagesCount": 5,
  "frontImage": "/public/uploads/front-image-123.jpg",
  "otherImages": [
    "/public/uploads/room-1-456.jpg",
    "/public/uploads/room-2-789.jpg",
    "/public/uploads/lobby-012.jpg"
  ],
  "reference": "ACC-2026-001",
  "isNew": true,
  "tinNumber": "TIN-123456789",
  "businessLicenseNumber": "BL-987654321",
  "tinDocumentUrl": "/public/uploads/documents/tin-doc-123.pdf",
  "businessLicenseDocumentUrl": "/public/uploads/documents/license-doc-456.pdf",
  "mobileProvider": "Vodacom",
  "bankName": "CRDB Bank",
  "accountNumber": "1234567890123456",
  "accountName": "Sunset Beach Resort Ltd",
  "mobileNumber": "0789123456",
  "registerName": "John Doe",
  "wallet": {
    "credit": 0,
    "debit": 0,
    "balance": 0
  }
}
```

#### Success Response (201)

```json
{
  "message": "Accommodation registered successfully",
  "accommodationId": "507f1f77bcf86cd799439011",
  "reference": "ACC-2026-001",
  "status": "pending",
  "adminApprovalRequired": true
}
```

#### Error Responses

**Missing Required Fields (400)**

```json
{
  "message": "Missing required fields",
  "missingFields": ["name", "location"]
}
```

**Invalid Document URLs (400)**

```json
{
  "message": "Document URLs must point to valid PDF files"
}
```

**Invalid Array Format (400)**

```json
{
  "message": "Amenities must be an array"
}
```

**Server Error (500)**

```json
{
  "message": "Accommodation registration failed"
}
```

---

## Field Specifications

### Required Fields

| Field                        | Type   | Description               | Example                                 |
| ---------------------------- | ------ | ------------------------- | --------------------------------------- |
| `name`                       | string | Accommodation name        | "Sunset Beach Resort"                   |
| `description`                | string | Detailed description      | "Luxury beachfront..."                  |
| `location`                   | string | Physical location         | "Dar es Salaam"                         |
| `type`                       | string | Accommodation type        | "Hotel", "Hostel", "Guesthouse"         |
| `amenities`                  | array  | List of amenities         | `["WiFi", "Pool", "Restaurant"]`        |
| `frontImage`                 | string | Front image URL           | "/public/uploads/front.jpg"             |
| `otherImages`                | array  | Additional image URLs     | `["/public/uploads/room1.jpg"]`         |
| `reference`                  | string | Unique reference code     | "ACC-2026-001"                          |
| `tinNumber`                  | string | Tax ID Number             | "TIN-123456789"                         |
| `businessLicenseNumber`      | string | Business license number   | "BL-987654321"                          |
| `tinDocumentUrl`             | string | URL to TIN PDF            | "/public/uploads/documents/tin.pdf"     |
| `businessLicenseDocumentUrl` | string | URL to license PDF        | "/public/uploads/documents/license.pdf" |
| `mobileProvider`             | string | Mobile payment provider   | "Vodacom", "Airtel", "Tigo"             |
| `bankName`                   | string | Bank name                 | "CRDB Bank", "NMB"                      |
| `accountNumber`              | string | Bank account number       | "1234567890123456"                      |
| `accountName`                | string | Account holder name       | "Resort Account Name"                   |
| `mobileNumber`               | string | Contact mobile number     | "0789123456"                            |
| `registerName`               | string | Registration contact name | "John Doe"                              |

### Optional Fields

| Field              | Type    | Default                          | Description                |
| ------------------ | ------- | -------------------------------- | -------------------------- |
| `otherImagesCount` | number  | `otherImages.length`             | Count of additional images |
| `wallet`           | object  | `{credit:0, debit:0, balance:0}` | Initial wallet structure   |
| `isNew`            | boolean | `true`                           | Marks as new registration  |

### Wallet Structure

```json
{
  "credit": 0,
  "debit": 0,
  "balance": 0
}
```

---

## Important Notes for Frontend

### 1. Document URLs

- **Must be PDF files** - URLs should end with `.pdf`
- **Pre-uploaded** - Documents must be uploaded before calling this endpoint
- **Accessible** - URLs should point to valid, accessible files
- **Format**: Use relative URLs like `/public/uploads/documents/filename.pdf`

### 2. Image URLs

- Store complete URLs from image upload responses
- Front image should be a representative image
- Other images can be room photos, lobby, amenities, etc.

### 3. Reference Code

- Generate a unique reference code before submission
- Format suggestion: `ACC-YYYY-XXXXX` (e.g., `ACC-2026-00001`)
- Used for tracking and identification

### 4. Approval Status

- All new accommodations start with `adminApproval: false`
- User will need to wait for admin approval
- Consider showing "Pending Approval" status in UI

### 5. Error Handling

- Check for `missingFields` array in 400 response to highlight missing fields
- Validate client-side before sending to reduce server requests
- Handle PDF validation errors gracefully

---

## Frontend Implementation Example (JavaScript)

```javascript
// Function to register accommodation
async function registerAccommodation(finalPayload) {
  try {
    const response = await fetch(
      "http://localhost:3000/management/accommodations/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(finalPayload),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      if (data.missingFields) {
        console.error("Missing fields:", data.missingFields);
        // Highlight missing fields in UI
      } else {
        console.error("Error:", data.message);
      }
      throw new Error(data.message);
    }

    console.log("Success:", data);
    return {
      accommodationId: data.accommodationId,
      reference: data.reference,
      status: data.status,
    };
  } catch (error) {
    console.error("Registration failed:", error);
    throw error;
  }
}

// Usage
const payload = {
  name: "My Resort",
  description: "Beautiful resort",
  location: "Beach Area",
  type: "Resort",
  amenities: ["WiFi", "Pool"],
  frontImage: "/public/uploads/front.jpg",
  otherImages: ["/public/uploads/room.jpg"],
  reference: "ACC-2026-00001",
  tinNumber: "TIN-123",
  businessLicenseNumber: "BL-456",
  tinDocumentUrl: "/public/uploads/documents/tin.pdf",
  businessLicenseDocumentUrl: "/public/uploads/documents/license.pdf",
  mobileProvider: "Vodacom",
  bankName: "CRDB",
  accountNumber: "123456789",
  accountName: "Resort Account",
  mobileNumber: "0789123456",
  registerName: "Owner Name",
};

registerAccommodation(payload)
  .then((result) => {
    console.log("Accommodation registered:", result);
    // Redirect to success page or show confirmation
  })
  .catch((error) => {
    console.error("Failed to register:", error);
    // Show error message to user
  });
```

---

## Validation Checklist for Frontend

Before submitting to the backend, verify:

- ✅ All required fields are present and not empty
- ✅ `amenities` is an array with at least one item
- ✅ `otherImages` is an array (can be empty)
- ✅ `frontImage` URL is valid
- ✅ Document URLs end with `.pdf`
- ✅ Document URLs are accessible
- ✅ Mobile number is valid format
- ✅ Bank account number is valid format
- ✅ Reference code is unique
- ✅ All strings are trimmed of whitespace

---

## Status Codes

| Code | Meaning              | Action                                  |
| ---- | -------------------- | --------------------------------------- |
| 201  | Created successfully | Show confirmation, save accommodationId |
| 400  | Bad request          | Check errors and fix data               |
| 500  | Server error         | Retry after delay, contact support      |

---

## Next Steps After Registration

1. **Store the accommodationId** - Use it for future updates
2. **Show reference to user** - Display `reference` for tracking
3. **Set status indicator** - Show "Pending Admin Approval"
4. **Redirect user** - Navigate to dashboard or confirmation page
5. **Notify user** - Email or in-app notification about pending approval
