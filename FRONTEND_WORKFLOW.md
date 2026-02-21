# Frontend Accommodation Registration - Complete Workflow Guide

## Overview

The frontend needs to collect accommodation data, upload images and documents separately, then submit the final payload with all URLs to the backend.

---

## Step-by-Step Process

### Step 1: Collect Form Data

Gather all accommodation information from the user form:

```javascript
const formData = {
  // Basic Information
  name: document.getElementById("accommodationName").value,
  description: document.getElementById("description").value,
  location: document.getElementById("location").value,
  type: document.getElementById("type").value, // Hotel, Hostel, etc.
  amenities: Array.from(
    document.querySelectorAll('input[name="amenities"]:checked'),
  ).map((cb) => cb.value),

  // Business Information
  tinNumber: document.getElementById("tinNumber").value,
  businessLicenseNumber: document.getElementById("businessLicense").value,

  // Payment Details
  mobileProvider: document.getElementById("mobileProvider").value,
  bankName: document.getElementById("bankName").value,
  accountNumber: document.getElementById("accountNumber").value,
  accountName: document.getElementById("accountName").value,
  mobileNumber: document.getElementById("mobileNumber").value,
  registerName: document.getElementById("registerName").value,

  // Generated Data
  reference: generateReference(), // Generate unique reference
  isNew: true,
  wallet: {
    credit: 0,
    debit: 0,
    balance: 0,
  },
};
```

---

### Step 2: Upload Front Image

Upload the main accommodation image first.

```javascript
async function uploadFrontImage(imageFile) {
  const uploadFormData = new FormData();
  uploadFormData.append("image", imageFile);

  try {
    const response = await fetch(
      "http://localhost:3000/management/upload-image",
      {
        method: "POST",
        body: uploadFormData,
      },
    );

    const data = await response.json();

    if (response.ok) {
      return data.url; // Returns something like "/public/uploads/filename.jpg"
    } else {
      throw new Error(data.error || "Image upload failed");
    }
  } catch (error) {
    console.error("Front image upload error:", error);
    throw error;
  }
}

// Usage
const frontImageUrl = await uploadFrontImage(formData.frontImageFile);
```

---

### Step 3: Upload Additional Images

Upload all other accommodation images.

```javascript
async function uploadOtherImages(imageFiles) {
  const uploadedUrls = [];

  for (const imageFile of imageFiles) {
    const uploadFormData = new FormData();
    uploadFormData.append("image", imageFile);

    try {
      const response = await fetch(
        "http://localhost:3000/management/upload-image",
        {
          method: "POST",
          body: uploadFormData,
        },
      );

      const data = await response.json();

      if (response.ok) {
        uploadedUrls.push(data.url);
      } else {
        throw new Error(data.error || "Image upload failed");
      }
    } catch (error) {
      console.error(`Error uploading image:`, error);
      throw error;
    }
  }

  return uploadedUrls;
}

// Usage
const otherImageUrls = await uploadOtherImages(formData.otherImageFiles);
```

---

### Step 4: Upload Business Documents (PDFs)

Upload TIN document and Business License document.

```javascript
async function uploadDocument(pdfFile, fieldName) {
  const uploadFormData = new FormData();
  uploadFormData.append(fieldName, pdfFile);

  try {
    const response = await fetch(
      "http://localhost:3000/management/upload-document",
      {
        method: "POST",
        body: uploadFormData,
      },
    );

    const data = await response.json();

    if (response.ok) {
      return data.url; // Returns something like "/public/uploads/documents/filename.pdf"
    } else {
      throw new Error(data.error || "Document upload failed");
    }
  } catch (error) {
    console.error(`Error uploading ${fieldName}:`, error);
    throw error;
  }
}

// Usage - Upload both documents
const tinDocumentUrl = await uploadDocument(
  formData.tinDocumentFile,
  "tinDocument",
);
const businessLicenseUrl = await uploadDocument(
  formData.businessLicenseFile,
  "businessLicenseDocument",
);
```

---

### Step 5: Validate All Data

Before sending to backend, validate all required data is present.

```javascript
function validateAllData(formData, imageUrls) {
  const errors = [];

  // Check required form fields
  if (!formData.name) errors.push("Accommodation name is required");
  if (!formData.description) errors.push("Description is required");
  if (!formData.location) errors.push("Location is required");
  if (!formData.type) errors.push("Type is required");
  if (!formData.amenities || formData.amenities.length === 0)
    errors.push("Select at least one amenity");

  // Check business details
  if (!formData.tinNumber) errors.push("TIN number is required");
  if (!formData.businessLicenseNumber)
    errors.push("Business license number is required");

  // Check payment details
  if (!formData.mobileProvider) errors.push("Mobile provider is required");
  if (!formData.bankName) errors.push("Bank name is required");
  if (!formData.accountNumber) errors.push("Account number is required");
  if (!formData.accountName) errors.push("Account name is required");
  if (!formData.mobileNumber) errors.push("Mobile number is required");
  if (!formData.registerName) errors.push("Register name is required");

  // Check image URLs
  if (!imageUrls.frontImageUrl) errors.push("Front image upload failed");
  if (!imageUrls.otherImageUrls || imageUrls.otherImageUrls.length === 0)
    errors.push("At least one additional image is required");

  // Check document URLs
  if (!imageUrls.tinDocumentUrl) errors.push("TIN document upload failed");
  if (!imageUrls.businessLicenseUrl)
    errors.push("Business license document upload failed");

  return errors;
}
```

---

### Step 6: Build Final Payload

Combine all data with uploaded URLs.

```javascript
function buildFinalPayload(formData, imageUrls) {
  return {
    // Accommodation Details
    name: formData.name,
    description: formData.description,
    location: formData.location,
    type: formData.type,
    amenities: formData.amenities,

    // Images
    frontImage: imageUrls.frontImageUrl,
    otherImages: imageUrls.otherImageUrls,
    otherImagesCount: imageUrls.otherImageUrls.length,

    // Business Documents & Numbers
    tinNumber: formData.tinNumber,
    businessLicenseNumber: formData.businessLicenseNumber,
    tinDocumentUrl: imageUrls.tinDocumentUrl,
    businessLicenseDocumentUrl: imageUrls.businessLicenseUrl,

    // Payment Information
    mobileProvider: formData.mobileProvider,
    bankName: formData.bankName,
    accountNumber: formData.accountNumber,
    accountName: formData.accountName,
    mobileNumber: formData.mobileNumber,
    registerName: formData.registerName,

    // Metadata
    reference: formData.reference,
    isNew: formData.isNew,
    adminApproval: false,

    // Wallet
    wallet: formData.wallet,
  };
}
```

---

### Step 7: Submit to Backend

Send the complete payload with all URLs to the registration endpoint.

```javascript
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
        showError(`Missing required fields: ${data.missingFields.join(", ")}`);
      } else {
        showError(data.message);
      }
      throw new Error(data.message);
    }

    return {
      success: true,
      accommodationId: data.accommodationId,
      reference: data.reference,
      status: data.status,
    };
  } catch (error) {
    console.error("Registration failed:", error);
    throw error;
  }
}
```

---

## Complete Workflow Example

```javascript
async function completeRegistrationWorkflow(
  formData,
  frontImageFile,
  otherImageFiles,
  tinPdfFile,
  licensePdfFile,
) {
  try {
    console.log("Starting accommodation registration...");

    // Step 1: Upload all images
    console.log("Uploading front image...");
    const frontImageUrl = await uploadFrontImage(frontImageFile);

    console.log("Uploading other images...");
    const otherImageUrls = await uploadOtherImages(otherImageFiles);

    // Step 2: Upload documents
    console.log("Uploading TIN document...");
    const tinDocumentUrl = await uploadDocument(tinPdfFile, "tinDocument");

    console.log("Uploading business license...");
    const businessLicenseUrl = await uploadDocument(
      licensePdfFile,
      "businessLicenseDocument",
    );

    // Step 3: Prepare image URLs object
    const imageUrls = {
      frontImageUrl,
      otherImageUrls,
      tinDocumentUrl,
      businessLicenseUrl,
    };

    // Step 4: Validate all data
    console.log("Validating data...");
    const errors = validateAllData(formData, imageUrls);

    if (errors.length > 0) {
      showError(`Validation failed:\n${errors.join("\n")}`);
      return null;
    }

    // Step 5: Build final payload
    console.log("Building final payload...");
    const finalPayload = buildFinalPayload(formData, imageUrls);

    console.log("Final payload:", finalPayload);

    // Step 6: Register accommodation
    console.log("Submitting to backend...");
    const result = await registerAccommodation(finalPayload);

    // Step 7: Handle success
    showSuccess(
      `Accommodation registered successfully!\nReference: ${result.reference}`,
    );
    console.log("Registration result:", result);

    // Redirect to success page or dashboard
    // window.location.href = '/accommodation-success?id=' + result.accommodationId;

    return result;
  } catch (error) {
    console.error("Workflow error:", error);
    showError("Failed to register accommodation. Please try again.");
    return null;
  }
}

// Usage when user submits the form
document
  .getElementById("registrationForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    const formData = collectFormData();
    const frontImageFile = document.getElementById("frontImage").files[0];
    const otherImageFiles = Array.from(
      document.getElementById("otherImages").files,
    );
    const tinPdfFile = document.getElementById("tinDocument").files[0];
    const licensePdfFile = document.getElementById("businessLicense").files[0];

    const result = await completeRegistrationWorkflow(
      formData,
      frontImageFile,
      otherImageFiles,
      tinPdfFile,
      licensePdfFile,
    );

    if (result) {
      // Success - do something
    }
  });
```

---

## Helper Functions

### Generate Unique Reference

```javascript
function generateReference() {
  const year = new Date().getFullYear();
  const randomNum = Math.floor(Math.random() * 100000)
    .toString()
    .padStart(5, "0");
  return `ACC-${year}-${randomNum}`;
}
```

### Show Error/Success Messages

```javascript
function showError(message) {
  // Update UI with error message
  const errorDiv = document.getElementById("errorMessage");
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.style.display = "block";
  }
  console.error(message);
}

function showSuccess(message) {
  // Update UI with success message
  const successDiv = document.getElementById("successMessage");
  if (successDiv) {
    successDiv.textContent = message;
    successDiv.style.display = "block";
  }
  console.log(message);
}
```

---

## Data Flow Diagram

```
┌─────────────────────────────────┐
│  User Fills Registration Form   │
└────────────────┬────────────────┘
                 │
        ┌────────▼────────┐
        │  Collect Data   │
        └────────┬────────┘
                 │
    ┌────────────┴────────────┐
    │                         │
┌───▼────┐          ┌────────▼────────┐
│ Upload │          │  Upload PDF     │
│ Images │          │  Documents      │
└───┬────┘          └────────┬────────┘
    │                        │
    │   ┌────────────────────┤
    │   │                    │
┌───▼───▼────────────────────▼──┐
│  Build Final Payload with URLs │
└───┬───────────────────────────┘
    │
┌───▼──────────────────────┐
│  Validate All Data       │
└───┬──────────────────────┘
    │
┌───▼──────────────────────┐
│  Send to Backend         │
│  /accommodations/register│
└───┬──────────────────────┘
    │
┌───▼──────────────────────┐
│  Receive Response        │
│  - accommodationId       │
│  - reference             │
│  - status (pending)      │
└──────────────────────────┘
```

---

## Key Points

1. **Upload images FIRST** - Get URLs before submitting to backend
2. **Upload PDFs SECOND** - Validate they're actual PDF files
3. **Build payload with URLs** - Never send raw file data
4. **Validate before sending** - Check all required fields are present
5. **Handle errors gracefully** - Show meaningful error messages to users
6. **Save reference** - Display reference code to user for tracking
7. **Check status** - New accommodations start with `status: "pending"` (awaiting admin approval)
