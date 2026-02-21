# Accommodation Registration Implementation

## Overview

Implemented the `POST /management/accommodations/register` endpoint to handle accommodation registration with pre-uploaded document URLs and comprehensive validation.

## Endpoint Details

### Route

```
POST /management/accommodations/register
```

### Request Payload Structure

```json
{
  "name": "string",
  "description": "string",
  "location": "string",
  "type": "string",
  "amenities": ["string"],
  "otherImagesCount": "number",
  "frontImage": "string (url)",
  "otherImages": ["string (urls)"],
  "reference": "string",
  "isNew": true,
  "tinNumber": "string",
  "businessLicenseNumber": "string",
  "tinDocumentUrl": "string (url to PDF)",
  "businessLicenseDocumentUrl": "string (url to PDF)",
  "mobileProvider": "string",
  "bankName": "string",
  "accountNumber": "string",
  "accountName": "string",
  "mobileNumber": "string",
  "registerName": "string",
  "wallet": {
    "credit": 0,
    "debit": 0,
    "balance": 0
  }
}
```

## Features Implemented

### 1. Validation

- ✅ Validates all required fields are present
- ✅ Verifies document URLs point to valid PDF files (extension check)
- ✅ Ensures amenities is an array
- ✅ Ensures otherImages is an array
- ✅ Returns detailed error messages with missing fields

### 2. Document Handling

- ✅ Accepts pre-uploaded document URLs
- ✅ Stores URLs exactly as received
- ✅ Associates documents with their corresponding numbers (TIN, Business License)
- ✅ Validates PDF file extension

### 3. Accommodation Record Creation

- ✅ Stores all accommodation information
- ✅ Links business verification documents and numbers
- ✅ Initializes wallet with provided structure (or defaults to 0)
- ✅ Sets adminApproval to false (pending approval)
- ✅ Stores user reference and metadata
- ✅ Saves all image URLs (front and additional images)
- ✅ Sets status to "pending" for admin review
- ✅ Records creation timestamp

### 4. Response Format

```json
{
  "message": "Accommodation registered successfully",
  "accommodationId": "mongodb_object_id",
  "reference": "user_provided_reference",
  "status": "pending",
  "adminApprovalRequired": true
}
```

## Error Responses

### Missing Required Fields

```json
{
  "message": "Missing required fields",
  "missingFields": ["field1", "field2"]
}
```

Status: 400

### Invalid Document URLs

```json
{
  "message": "Document URLs must point to valid PDF files"
}
```

Status: 400

### Invalid Data Types

```json
{
  "message": "Amenities must be an array"
}
```

Status: 400

## Database Collection

- **Collection**: `accommodations`
- **Fields Stored**:
  - Basic info: name, description, location, type
  - Images: frontImage, otherImages, otherImagesCount
  - Amenities: amenities array
  - Documents: tinDocumentUrl, businessLicenseDocumentUrl
  - Document Numbers: tinNumber, businessLicenseNumber
  - Payment: mobileProvider, bankName, accountNumber, accountName, mobileNumber, registerName
  - Wallet: credit, debit, balance
  - Status: adminApproval (false), status ("pending"), isNew (true)
  - Metadata: reference, createdAt, updatedAt

## Important Notes

1. **Pre-uploaded Documents**: Document URLs are already uploaded when the payload arrives. The backend stores the URLs without re-uploading.

2. **Admin Approval Workflow**: All new accommodations start with `adminApproval: false` and require manual approval before becoming active.

3. **Wallet Initialization**: Defaults to zero balance if not provided, but accepts custom wallet structure.

4. **PDF Validation**: Currently validates PDF extension. Can be enhanced to verify actual PDF file content.

## Future Enhancements

1. Validate TIN/License numbers against government databases if available
2. Send verification email to user with accommodation details
3. Create audit log for new accommodation registration
4. Notify admin panel for approval review
5. Implement document download/access control
6. Verify actual PDF file content (not just extension)
7. Add rate limiting to prevent abuse
8. Implement file signature verification for documents

## Usage Example

```javascript
const payload = {
  name: "Sunset Beach Resort",
  description: "Luxury beachfront accommodation",
  location: "Dar es Salaam",
  type: "Hotel",
  amenities: ["WiFi", "Pool", "Restaurant", "Spa"],
  otherImagesCount: 5,
  frontImage: "/public/uploads/front-123.jpg",
  otherImages: ["/public/uploads/room-1.jpg", "/public/uploads/room-2.jpg"],
  reference: "ACC-2026-001",
  isNew: true,
  tinNumber: "TIN-123456789",
  businessLicenseNumber: "BL-987654321",
  tinDocumentUrl: "/public/uploads/documents/tin-doc-123.pdf",
  businessLicenseDocumentUrl: "/public/uploads/documents/license-doc-456.pdf",
  mobileProvider: "Vodacom",
  bankName: "CRDB Bank",
  accountNumber: "1234567890",
  accountName: "Resort Account",
  mobileNumber: "0789123456",
  registerName: "Resort Manager",
  wallet: {
    credit: 0,
    debit: 0,
    balance: 0,
  },
};

// POST request
fetch("/management/accommodations/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
})
  .then((res) => res.json())
  .then((data) => console.log(data));
```

## Implementation Location

- **File**: [routes/management/index.js](routes/management/index.js)
- **Lines**: 292-387
