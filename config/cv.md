# Rohan Aluri — CV

**Phone:** 678-283-5911
**Email:** rohanaluri@gmail.com
**LinkedIn:** [rohan-aluri-09316422b](https://linkedin.com/in/rohan-aluri-09316422b/)
**Citizenship:** U.S. Citizen

## Education

**Georgia Institute of Technology** — M.S. in Analytics; GPA: 4.0/4.0 — Graduation: May 2026, Atlanta, GA
Relevant coursework: Natural Language Processing, Bayesian Statistics, Deep Learning, Time Series Analysis, Reinforcement Learning

**Georgia Institute of Technology** — B.S. in Industrial & Systems Engineering; GPA: 3.9/4.0 — Graduation: May 2025, Atlanta, GA
Relevant coursework: Data Input/Manipulation, Machine Learning, Statistical Methods, Decision & Data Analysis, Constraint Programming

## Experience

**ADP — Associate Data Scientist** (July 2025 – Present), Alpharetta, GA

- Designed an event-driven Flask service (AWS SNS/SQS, MySQL) to detect rate changes across 52 U.S. prevailing wage sources and automate pull requests into downstream policy templates
- Developed an LLM extraction pipeline with Strands Agents that converted 5,000+ rate publications into structured data, enforcing a 95% field-accuracy gate on all prompt updates
- Implemented OpenTelemetry trace propagation across 9 event types to debug requests end to end in Splunk and Dynatrace
- Authored Dockerfiles and maintained Helm charts for Kubernetes autoscaling (2 to 64 pods) and environment promotion
- Configured Concourse pipelines to run 2,000+ pytest tests and deploy with automated Liquibase database migrations

**ADP — Data Science Intern** (May 2024 – August 2024), Alpharetta, GA

- Constructed a Databricks pipeline using LangChain and Azure OpenAI (GPT-4 Turbo) to extract earnings, deductions, and net pay from payroll PDFs into a standardized JSON schema
- Engineered 6 vendor-specific few-shot prompt templates, reaching 92% accuracy against ground truth comparisons
- Deployed AWS Lambda functions for real-time extraction via a Swagger API, storing outputs in S3

**Epic Intentions Consulting — Senior Consultant** (January 2024 – May 2024), Atlanta, GA

- Migrated the H.E.R.O. for Children website from Joomla to WordPress, cutting hosting costs by 35%, and rewrote site content using Python text analysis (NLTK tokenization, TF-IDF keyword extraction)
- Redesigned the site into 7 pages, using Google Analytics page-flow and bounce-rate data to streamline user journeys

**NCR Corporation — Product Management Intern** (May 2023 – August 2023), Atlanta, GA

- Built a client-facing Order Confirmation Index for 45 digital signage products, compiling technical specifications from NCR's GSDB and Merlin cloud-based platforms
- Identified potential SKUs for discontinuation via Mann-Kendall tests on Q3 audit data, flagging products with sales declines
- Mapped the kiosk self-checkout flow to find friction points, then used Monte Carlo simulation of scan, payment, and attendant-assist times to model a 3.6% faster transaction

**Georgia Institute of Technology — Undergraduate Research** (January 2022 – May 2023), Atlanta, GA

- Analyzed opioid usage patterns across demographic groups enrolled in Medicaid under Dr. Nicoleta Serban
- Queried and merged multi-table Medicaid MAX and TAF files from ResDAC using SQL joins, managing 20,000+ patient records with data cleaning and integrity checks
- Constructed SQL stored procedures with CASE logic to categorize socioeconomic data, and used Seaborn to visualize relationships and model fit through scatter and residual plots

## Projects

- **Employee Benefits Feedback Analysis (RAG & Vector Search)** — Designed a document chunking pipeline that splits HR policy PDFs and employee survey feedback by headers and paragraphs to produce high-quality embeddings; developed a RAG chatbot in LangChain with integrated OpenAI embeddings and a Chroma vector database, enabling semantic search and conversation memory; implemented safety guardrails to ensure outputs were contextually grounded in HR policies through Giskard tests; built a Streamlit dashboard for HR decision-makers that surfaces semantic search results, employee benefit utilization by department, and sentiment trends in surveys.
- **Customer Churn Prediction (Random Forest & Customer Segmentation)** — Merged four sponsor Excel datasets (profiles, orders, memberships, sales history) into a 6,857-customer master table, addressing class imbalance with balanced class weights and stratified 75/25 train/test splits; trained time-aware Random Forest (depth 8, min 20 samples per leaf) and Logistic Regression models, validating robustness by re-running the pipeline across 4 alternate cutoff dates; deployed a High/Medium/Low churn-segmentation framework driven by model feature importances; validated tier-specific retention strategies on held-out data, where high-risk members churned at 3.6x the rate of low-risk members.

## Technical Skills

**Languages & Libraries:** Python, SQL, R, Java, JavaScript, C++, Spark, Pandas, NumPy, Scikit-Learn, TensorFlow, LangChain
**Tools:** AWS, Databricks, Docker, Kubernetes, Helm, Git, Concourse, Splunk, Dynatrace, OpenTelemetry, Liquibase, Swagger
**Additional Skills:** Generative AI, LLM Agents, Prompt Engineering, RAG, REST APIs, Spec-Driven Development, A/B Testing
