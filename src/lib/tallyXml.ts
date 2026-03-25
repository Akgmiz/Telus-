import { format, parse, isValid } from "date-fns";

export interface InvoiceItem {
  itemName: string;
  qty: string;
  rate: string;
  amount: string;
}

export interface InvoiceData {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: string;
  taxAmount: string;
  items: InvoiceItem[];
}

export interface TallyValidationResult {
  isValid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Robustly parses an invoice date string into a Date object.
 * Tries multiple common invoice formats.
 */
function parseInvoiceDate(dateStr: string): Date {
  if (!dateStr) return new Date();

  // Clean the string: remove extra spaces, handle common variations
  const cleanDate = dateStr.trim();

  // 1. Try native Date parsing (handles ISO and many standard formats)
  const nativeDate = new Date(cleanDate);
  if (isValid(nativeDate)) return nativeDate;

  // 2. Try specific common invoice formats using date-fns
  const formats = [
    "dd-MMM-yyyy",
    "dd/MM/yyyy",
    "MM/dd/yyyy",
    "yyyy-MM-dd",
    "dd-MM-yyyy",
    "MMM dd, yyyy",
    "dd MMM yyyy",
    "d MMM yyyy",
    "d-MMM-yyyy",
    "dd/MMM/yyyy",
  ];

  for (const fmt of formats) {
    try {
      const parsed = parse(cleanDate, fmt, new Date());
      if (isValid(parsed)) return parsed;
    } catch (e) {
      // Continue to next format
    }
  }

  // Fallback to current date if all parsing fails
  console.warn(`Failed to parse date: "${dateStr}". Using current date.`);
  return new Date();
}

/**
 * Escapes special characters for XML.
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

/**
 * Cleans an amount string by removing commas and other non-numeric characters except decimal point.
 */
function cleanAmount(amount: string): string {
  if (!amount) return "0";
  // Remove commas and any other characters except digits and dot
  return amount.replace(/,/g, "").replace(/[^0-9.]/g, "");
}

/**
 * Validates data for Tally compatibility.
 */
export function validateTallyData(data: InvoiceData): TallyValidationResult {
  const result: TallyValidationResult = {
    isValid: true,
    warnings: [],
    errors: [],
  };

  if (!data.vendorName) {
    result.errors.push("Vendor Name is missing.");
    result.isValid = false;
  }

  if (data.vendorName && data.vendorName.length > 100) {
    result.warnings.push("Vendor Name is very long; Tally ledgers usually have shorter names.");
  }

  const cleanedAmount = cleanAmount(data.totalAmount);
  if (!data.totalAmount || isNaN(Number(cleanedAmount))) {
    result.errors.push("Total Amount must be a valid number.");
    result.isValid = false;
  }

  if (data.vendorName && /[&<>]/.test(data.vendorName)) {
    result.warnings.push("Vendor Name contains special characters (&, <, >) which will be escaped for XML.");
  }

  // Check for characters explicitly invalid in Tally ledger names
  // Tally generally forbids * and ? in names as they are used for wildcards
  const invalidTallyChars = /[*?]/;
  if (data.vendorName && invalidTallyChars.test(data.vendorName)) {
    result.errors.push("Vendor Name contains invalid characters (* or ?). Tally does not allow these in ledger names.");
    result.isValid = false;
  }

  // Check for other potentially problematic characters not handled by XML escaping
  const problematicChars = /[\\/|:;~`^+=}{[\]]/;
  if (data.vendorName && problematicChars.test(data.vendorName)) {
    result.warnings.push("Vendor Name contains characters (\\, /, |, :, ;, etc.) that might cause issues in some Tally versions.");
  }

  // Check if date is within a reasonable range
  const parsedDate = parseInvoiceDate(data.invoiceDate);
  const year = parsedDate.getFullYear();
  if (year < 2000 || year > 2050) {
    result.warnings.push(`Invoice date year (${year}) seems unusual.`);
  }

  // Validate items if present
  if (data.items && data.items.length > 0) {
    data.items.forEach((item, index) => {
      if (!item.itemName) {
        result.errors.push(`Item #${index + 1} is missing a name.`);
        result.isValid = false;
      }
      if (isNaN(parseFloat(item.amount))) {
        result.errors.push(`Item #${index + 1} (${item.itemName || 'Unnamed'}) has an invalid amount.`);
        result.isValid = false;
      }
    });
  }

  return result;
}

export function generateTallyXml(invoiceData: InvoiceData): string {
  // Date format for Tally (YYYYMMDD)
  const d = parseInvoiceDate(invoiceData.invoiceDate);
  const tallyDate = d.getFullYear() + 
                    String(d.getMonth() + 1).padStart(2, '0') + 
                    String(d.getDate()).padStart(2, '0');

  // Party/Vendor ka Total Credit Amount
  const totalAmount = parseFloat(cleanAmount(invoiceData.totalAmount)).toFixed(2);
  const taxAmount = parseFloat(cleanAmount(invoiceData.taxAmount)).toFixed(2);

  // 1. Har item ke liye Inventory Tag generate karna
  let inventoryXML = '';
  if (invoiceData.items && Array.isArray(invoiceData.items)) {
    invoiceData.items.forEach(item => {
      const itemAmount = parseFloat(cleanAmount(item.amount)).toFixed(2);
      const itemRate = parseFloat(cleanAmount(item.rate)).toFixed(2);
      const itemQty = parseFloat(cleanAmount(item.qty)).toFixed(2);
      
      inventoryXML += `
            <INVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${escapeXml(item.itemName)}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <BILLEDQTY>${itemQty} Nos</BILLEDQTY>
              <RATE>${itemRate}/Nos</RATE>
              <AMOUNT>-${itemAmount}</AMOUNT>
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>Purchase A/c</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-${itemAmount}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </INVENTORYENTRIES.LIST>`;
    });
  }

  // 2. Final XML Envelope me sab kuch jodna
  const finalXML = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>Telus Digital</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create">
            <DATE>${tallyDate}</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${escapeXml(invoiceData.invoiceNumber)}</VOUCHERNUMBER>
            <REFERENCE>${escapeXml(invoiceData.invoiceNumber)}</REFERENCE>
            <PARTYLEDGERNAME>${escapeXml(invoiceData.vendorName)}</PARTYLEDGERNAME>
            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
            
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(invoiceData.vendorName)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${totalAmount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>

            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Input Tax</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${taxAmount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>

            ${inventoryXML}

          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  return finalXML;
}

export function isDownloadSupported(): boolean {
  return typeof Blob !== 'undefined' && typeof window.URL !== 'undefined' && typeof document.createElement !== 'undefined';
}

export function downloadXml(xml: string, filename: string = "Tally_Import.xml") {
  try {
    if (!xml) {
      throw new Error("XML content is empty.");
    }

    if (!isDownloadSupported()) {
      throw new Error("Your browser does not support file downloads. Please try a modern browser like Chrome or Firefox.");
    }

    const blob = new Blob([xml], { type: "text/xml" });
    const url = window.URL.createObjectURL(blob);
    
    try {
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      // Clean up the URL object after a short delay to ensure the download starts
      setTimeout(() => window.URL.revokeObjectURL(url), 100);
    }
  } catch (error) {
    console.error("Download error:", error);
    throw error;
  }
}
