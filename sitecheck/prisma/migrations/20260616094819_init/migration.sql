-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "websiteUrl" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL DEFAULT '',
    "evaluatorLanguage" TEXT NOT NULL DEFAULT 'en',
    "deviceType" TEXT NOT NULL DEFAULT 'desktop',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalScore" REAL NOT NULL DEFAULT 0,
    "maxScore" REAL NOT NULL DEFAULT 118,
    "percentage" REAL NOT NULL DEFAULT 0,
    "grade" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CriterionResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditJobId" TEXT NOT NULL,
    "qid" TEXT NOT NULL,
    "criterionNameEN" TEXT NOT NULL,
    "criterionNameAR" TEXT NOT NULL,
    "pillar" TEXT NOT NULL,
    "subPillar" TEXT NOT NULL DEFAULT '',
    "scoreEarned" REAL NOT NULL,
    "maxScore" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "screenshotPath" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "recommendation" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "CriterionResult_auditJobId_fkey" FOREIGN KEY ("auditJobId") REFERENCES "AuditJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PdfReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditJobId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PdfReport_auditJobId_fkey" FOREIGN KEY ("auditJobId") REFERENCES "AuditJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
